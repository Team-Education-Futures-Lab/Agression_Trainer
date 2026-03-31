import type {
    AnalysisWindow,
    AudioChunk,
    BehaviourResult,
    ClipMetadata,
    ServerMessage,
    VideoFrame,
} from "@ar-training/shared";
import type { CoordinatorConfig } from "./types.js";
import { ServiceRouter } from "./service-router.js";
import { ClipSession, defaultWsFactory, type WsFactory } from "./clip-session.js";

export type SendFn = (message: ServerMessage) => void;

// How long flushSession waits for the ClipSession to resolve before proceeding
// with whatever has accumulated.
const CLIP_RESOLVE_TIMEOUT_MS = 5_000;

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
    clipSession:    ClipSession;
    sendFn:         SendFn;
    sequence:       number;
    lastResult:     BehaviourResult | null;
    lastTranscript: string | null;
    /** ISO 639-1 language code for this session, forwarded to ClipSession. */
    language:       string;
}

// ─── Coordinator ──────────────────────────────────────────────────────────────

export class Coordinator {
    private readonly evalRouter:   ServiceRouter;
    private readonly transRouter:  ServiceRouter;
    private readonly sessions:     Map<string, SessionState> = new Map();
    private readonly authHeader:   string;
    private readonly wsFactory:    WsFactory;

    constructor(
        config:    CoordinatorConfig,
        wsFactory: WsFactory = defaultWsFactory,
    ) {
        this.evalRouter  = new ServiceRouter(config.evaluationUrls);
        this.transRouter = new ServiceRouter(config.transcriptionUrls);
        this.authHeader  = `Bearer ${config.internalApiKey}`;
        this.wsFactory   = wsFactory;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Registers a new session and opens the first ClipSession to the
     * Transcription service.
     *
     * language is the ISO 639-1 code from SessionContext (set at session
     * creation via POST /session/create). It is forwarded to the Transcription
     * container via the WebSocket URL query parameter so Whisper uses the
     * correct language for this session.
     */
    registerSession(
        sessionId: string,
        clip:      ClipMetadata,
        sendFn:    SendFn,
        language:  string = "",
    ): void {
        const sequence    = 1;
        const clipSession = this.makeClipSession(sessionId, clip, sequence, sendFn, language);
        this.sessions.set(sessionId, {
            clipSession,
            sendFn,
            sequence,
            lastResult:     null,
            lastTranscript: null,
            language,
        });
    }

    deregisterSession(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (state) {
            state.clipSession.close();
            this.sessions.delete(sessionId);
        }
        this.evalRouter.releaseSession(sessionId);
        this.transRouter.releaseSession(sessionId);
    }

    onFrame(sessionId: string, frame: VideoFrame): void {
        this.sessions.get(sessionId)?.clipSession.onFrame(frame);
    }

    onAudio(sessionId: string, chunk: AudioChunk): void {
        this.sessions.get(sessionId)?.clipSession.onAudio(sessionId, chunk);
    }

    async flushSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        state.clipSession.flush();

        const timeout = new Promise<null>(res =>
            setTimeout(() => res(null), CLIP_RESOLVE_TIMEOUT_MS),
        );

        const window = await Promise.race([state.clipSession, timeout]);
        if (window === null) return;

        await this.dispatchWindow(sessionId, state, window);
    }

    async resetSession(sessionId: string, nextClip: ClipMetadata | null): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        state.clipSession.close();
        state.lastTranscript = null;
        state.sequence++;

        if (nextClip !== null) {
            state.clipSession = this.makeClipSession(
                sessionId,
                nextClip,
                state.sequence,
                state.sendFn,
                state.language,
            );
        }

        await Promise.allSettled([
            fetch(`${this.evalRouter.getUrl(sessionId)}/evaluate/reset/${sessionId}`, {
                method:  "POST",
                headers: { "Authorization": this.authHeader },
            }),
            fetch(`${this.transRouter.getUrl(sessionId)}/transcription/reset/${sessionId}`, {
                method:  "POST",
                headers: { "Authorization": this.authHeader },
            }),
        ]);
    }

    getLastResult(sessionId: string): BehaviourResult | null {
        return this.sessions.get(sessionId)?.lastResult ?? null;
    }

    getLastTranscript(sessionId: string): string | null {
        return this.sessions.get(sessionId)?.lastTranscript ?? null;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private makeClipSession(
        sessionId: string,
        clip:      ClipMetadata,
        sequence:  number,
        sendFn:    SendFn,
        language:  string,
    ): ClipSession {
        return new ClipSession(
            sessionId,
            clip,
            this.transRouter.getUrl(sessionId),
            this.authHeader,
            this.wsFactory,
            sequence,
            (sid, transcript) => sendFn({
                type:           "session_update",
                session_id:     sid,
                transcript,
                queue_position: null,
            }),
            language,
        );
    }

    private async dispatchWindow(
        sessionId: string,
        state:     SessionState,
        window:    AnalysisWindow,
    ): Promise<void> {
        state.lastTranscript = window.transcript || null;

        try {
            const res = await fetch(`${this.evalRouter.getUrl(sessionId)}/evaluate/analyse`, {
                method:  "POST",
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": this.authHeader,
                },
                body: JSON.stringify(window),
            });

            if (!res.ok) return;

            state.lastResult = await res.json() as BehaviourResult;

        } catch {}
    }
}