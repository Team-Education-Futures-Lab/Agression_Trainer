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

// ─── Debug payload ────────────────────────────────────────────────────────────

/**
 * The debug payload returned by the Evaluation container when the request
 * carries X-Debug: true (admin sessions only). Stored in session state and
 * exposed via getLastDebug() for ClipController to include in debug_eval messages.
 */
export interface EvalDebugPayload {
    analyser_id: string;
    stages:      unknown;
}

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
    clipSession:    ClipSession;
    sendFn:         SendFn;
    sequence:       number;
    lastResult:     BehaviourResult | null;
    lastTranscript: string | null;
    lastDebug:      EvalDebugPayload | null;
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
            lastDebug:      null,
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

    /**
     * Flushes the current ClipSession, dispatches the AnalysisWindow to the
     * Evaluation container, and stores the result.
     *
     * When isAdmin is true the request carries X-Debug: true and the Evaluation
     * container includes a debug field in its response. The debug payload is
     * stored in session state and exposed via getLastDebug(). Non-admin sessions
     * never send the header — the Evaluation container bears no overhead of
     * assembling debug output for sessions that will not use it.
     */
    async flushSession(sessionId: string, isAdmin: boolean = false): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        state.clipSession.flush();

        const timeout = new Promise<null>(res =>
            setTimeout(() => res(null), CLIP_RESOLVE_TIMEOUT_MS),
        );

        const window = await Promise.race([state.clipSession, timeout]);
        if (window === null) return;

        await this.dispatchWindow(sessionId, state, window, isAdmin);
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

    /**
     * Returns the debug payload from the most recent evaluation dispatch for
     * this session, or null if the session is not admin, no evaluation has run,
     * or the evaluation fell back to neutral.
     */
    getLastDebug(sessionId: string): EvalDebugPayload | null {
        return this.sessions.get(sessionId)?.lastDebug ?? null;
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
        isAdmin:   boolean,
    ): Promise<void> {
        state.lastTranscript = window.transcript || null;
        state.lastDebug      = null;

        const headers: Record<string, string> = {
            "Content-Type":  "application/json",
            "Authorization": this.authHeader,
        };
        if (isAdmin) {
            headers["X-Debug"] = "true";
        }

        try {
            const res = await fetch(`${this.evalRouter.getUrl(sessionId)}/evaluate/analyse`, {
                method: "POST",
                headers,
                body:   JSON.stringify(window),
            });

            if (!res.ok) return;

            const body = await res.json() as BehaviourResult & {
                debug?: { analyser_id: string; stages: unknown };
            };

            // Separate the debug field (admin only) from the BehaviourResult.
            // The debug field is not part of BehaviourResult — strip it before storing.
            const { debug, ...result } = body;
            state.lastResult = result as BehaviourResult;

            if (isAdmin && debug) {
                state.lastDebug = {
                    analyser_id: debug.analyser_id,
                    stages:      debug.stages,
                };
            }

        } catch {}
    }
}