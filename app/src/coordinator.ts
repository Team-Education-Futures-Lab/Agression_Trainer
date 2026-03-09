import type {
    AnalysisWindow,
    AudioChunk,
    BehaviourResult,
    ClipMetadata,
    ServerMessage,
    VideoFrame,
} from "@ar-training/shared";
import type {CoordinatorConfig} from "./types.js";
import {ServiceRouter} from "./service-router.js";
import {ClipSession, defaultWsFactory, type WsFactory} from "./clip-session.js";

export type SendFn = (message: ServerMessage) => void;

// How long flushSession waits for the ClipSession to resolve before proceeding
// with whatever has accumulated. Whisper's VAD window is typically ≤2 s;
// 5 s gives ample headroom while keeping clip transitions responsive.
const CLIP_RESOLVE_TIMEOUT_MS = 5_000;

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
    clipSession:    ClipSession;
    sendFn:         SendFn;
    sequence:       number;
    lastResult:     BehaviourResult | null;
    lastTranscript: string | null;
}

// ─── Coordinator ──────────────────────────────────────────────────────────────
//
// Coordinates data flow between the client WebSocket, the Transcription service
// (via ClipSession), and the Evaluation container.
//
// One ClipSession is created per clip. It owns the WebSocket to the
// Transcription service, accumulates frames/MFCCs/transcript, and resolves as
// a thenable when the Transcription service emits a final transcript segment.
//
// Does not know about feedback, clip transitions, or session lifecycle —
// those are the responsibility of FeedbackClient and ClipController.
// ─────────────────────────────────────────────────────────────────────────────

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

    registerSession(sessionId: string, clip: ClipMetadata, sendFn: SendFn): void {
        const sequence    = 1;
        const clipSession = this.makeClipSession(sessionId, clip, sequence);
        this.sessions.set(sessionId, {
            clipSession,
            sendFn,
            sequence,
            lastResult:     null,
            lastTranscript: null,
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

    onFrame(frame: VideoFrame): void {
        this.sessions.get(frame.session_id)?.clipSession.onFrame(frame);
    }

    onAudio(chunk: AudioChunk): void {
        this.sessions.get(chunk.session_id)?.clipSession.onAudio(chunk);
    }

    /**
     * Signals the ClipSession to flush its transcript, then awaits the resolved
     * AnalysisWindow and dispatches it to the Evaluation container.
     *
     * A timeout fallback ensures a slow or unreachable Transcription container
     * cannot stall clip transitions indefinitely. On timeout the window is
     * discarded and the clip transition proceeds without an evaluation result.
     */
    async flushSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        state.clipSession.flush();

        const timeout = new Promise<null>(res =>
            setTimeout(() => res(null), CLIP_RESOLVE_TIMEOUT_MS),
        );

        const window = await Promise.race([state.clipSession, timeout]);
        if (window === null) return; // timed out — proceed without evaluation result

        await this.dispatchWindow(sessionId, state, window);
    }

    /**
     * Closes the current ClipSession, resets Evaluation and Transcription
     * buffers, and opens a fresh ClipSession for the next clip.
     *
     * nextClip must be the ClipMetadata for the clip that is about to start.
     * The new ClipSession begins connecting to the Transcription service
     * immediately so it is ready for the first audio chunk of the next clip.
     */
    async resetSession(sessionId: string, nextClip: ClipMetadata | null): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        state.clipSession.close();
        state.lastTranscript = null;
        state.sequence++;

        // nextClip is null for terminal clips — no transcription needed for the
        // next clip since deregisterSession will be called shortly after.
        if (nextClip !== null) {
            state.clipSession = this.makeClipSession(sessionId, nextClip, state.sequence);
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
        // Both resets are non-fatal — allSettled ensures neither blocks the other
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
    ): ClipSession {
        return new ClipSession(
            sessionId,
            clip,
            this.transRouter.getUrl(sessionId),
            this.authHeader,
            this.wsFactory,
            sequence,
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