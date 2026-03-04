import type {
    VideoFrame,
    AudioChunk,
    ClipMetadata,
    ServerMessage,
    AnalysisWindow,
    BehaviourResult,
} from "@ar-training/shared";
import type { CoordinatorConfig } from "./types.js";
import { ServiceRouter } from "./service-router.js";
import type { TranscriptionClient } from "./transcription-client.js";

export type SendFn = (message: ServerMessage) => void;

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
    clip:            ClipMetadata;
    sendFn:          SendFn;
    frames:          VideoFrame[];
    mfccs:           number[][][];
    sequence:        number;
    clipTranscript:  string;
    lastResult:      BehaviourResult | null;
}

// ─── Coordinator ──────────────────────────────────────────────────────────────
//
// Owns per-session frame and audio buffers. Accumulates data for the full
// duration of a clip and dispatches a single AnalysisWindow to the Evaluation
// container when the clip ends, populated with the complete transcript from
// the Transcription container.
//
// Does not know about feedback, clip transitions, or session lifecycle —
// those are the responsibility of FeedbackClient and ClipController.
// ─────────────────────────────────────────────────────────────────────────────

export class Coordinator {
    private readonly evalRouter:    ServiceRouter;
    private readonly transcription: TranscriptionClient;
    private readonly sessions:      Map<string, SessionState> = new Map();
    private readonly authHeader:    string;

    constructor(config: CoordinatorConfig, transcription: TranscriptionClient) {
        this.evalRouter    = new ServiceRouter(config.evaluationUrls);
        this.transcription = transcription;
        this.authHeader    = `Bearer ${config.internalApiKey}`;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    registerSession(sessionId: string, clip: ClipMetadata, sendFn: SendFn): void {
        this.sessions.set(sessionId, {
            clip,
            sendFn,
            frames:         [],
            mfccs:          [],
            sequence:       0,
            clipTranscript: "",
            lastResult:     null,
        });
        this.transcription.openSession(sessionId);
    }

    deregisterSession(sessionId: string): void {
        this.sessions.delete(sessionId);
        this.transcription.closeSession(sessionId);
        this.evalRouter.releaseSession(sessionId);
    }

    onFrame(frame: VideoFrame): void {
        const state = this.sessions.get(frame.session_id);
        if (!state) return;
        state.frames.push(frame);
    }

    onAudio(chunk: AudioChunk): void {
        const state = this.sessions.get(chunk.session_id);
        if (!state) return;
        state.mfccs.push(chunk.mfccs);
        this.transcription.sendAudio(chunk);
    }

    /**
     * Called by the TranscriptionClient when a transcript segment arrives.
     * Partial segments are accumulated; final segments are committed and
     * a SessionUpdate with the current transcript is sent to the client.
     */
    onTranscript(sessionId: string, text: string, isFinal: boolean): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        if (text) {
            state.clipTranscript = state.clipTranscript
                ? `${state.clipTranscript} ${text}`
                : text;
        }

        // Only send a SessionUpdate on final segments to avoid flooding the
        // client with every partial word. The client uses this for debugging.
        if (isFinal) {
            state.sendFn({
                type:           "session_update",
                session_id:     sessionId,
                transcript:     state.clipTranscript,
                queue_position: null,
            });
        }
    }

    setClip(sessionId: string, clip: ClipMetadata): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        state.clip = clip;
    }

    /**
     * Finalizes the transcript for the current clip, then dispatches a single
     * AnalysisWindow to the Evaluation container covering the full clip response.
     * Called by ClipController when a ClipEnded message is received.
     */
    async flushSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state || state.frames.length === 0) return;

        // Ask Transcription to flush any in-flight audio before we evaluate.
        await this.transcription.finaliseSession(
            sessionId,
            this.transcription.getUrl(sessionId),
        );

        await this.dispatchClipWindow(sessionId, state);
    }

    /**
     * Clears all accumulated clip data and resets the Transcription container's
     * VAD buffer. Called after a clip transition to prepare for the next clip.
     */
    async resetSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        state.frames        = [];
        state.mfccs         = [];
        state.clipTranscript = "";

        await this.transcription.resetSession(
            sessionId,
            this.transcription.getUrl(sessionId),
        );
        // Re-open the WebSocket for the next clip after reset.
        this.transcription.openSession(sessionId);

        try {
            await fetch(`${this.evalRouter.getUrl(sessionId)}/evaluate/reset/${sessionId}`, {
                method:  "POST",
                headers: { "Authorization": this.authHeader },
            });
        } catch {
            // Non-fatal — session continues regardless
        }
    }

    getLastResult(sessionId: string): BehaviourResult | null {
        return this.sessions.get(sessionId)?.lastResult ?? null;
    }

    getLastTranscript(sessionId: string): string | null {
        const state = this.sessions.get(sessionId);
        if (!state || state.clipTranscript === "") return null;
        return state.clipTranscript;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private async dispatchClipWindow(
        sessionId: string,
        state:     SessionState,
    ): Promise<void> {
        state.sequence++;
        const windowId = `${sessionId}:${state.sequence}`;

        const window: AnalysisWindow = {
            window_id:     windowId,
            session_id:    sessionId,
            frames:        state.frames,
            mfccs:         state.mfccs.flat(1),
            transcript:    state.clipTranscript,
            clip_metadata: state.clip,
        };

        state.frames         = [];
        state.mfccs          = [];
        state.clipTranscript = "";

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

            const result     = await res.json() as BehaviourResult;
            state.lastResult = result;

        } catch {}
    }
}
