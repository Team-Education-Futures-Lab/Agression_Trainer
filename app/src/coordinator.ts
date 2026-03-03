import type {
    VideoFrame,
    AudioChunk,
    ClipMetadata,
    ServerMessage,
    AnalysisWindow,
    BehaviourResult
} from "@ar-training/shared";
import type { CoordinatorConfig } from "./types.js";
import {clearTimeout} from "node:timers";
import {EvaluationRouter} from "./evaluation-router.js";

export type SendFn = (message: ServerMessage) => void;

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
    clip:           ClipMetadata;
    sendFn:         SendFn;
    frames:         VideoFrame[];
    mfccs:          number[][][];
    sequence:       number;
    clipScores:     number[];
    lastResult:     BehaviourResult | null;
    lastTranscript: string;
    timer:          NodeJS.Timeout;
}

// ─── Coordinator ──────────────────────────────────────────────────────────────
export class Coordinator {
    private readonly config:     CoordinatorConfig;
    private readonly router:     EvaluationRouter;
    private readonly sessions:   Map<string, SessionState> = new Map();
    private readonly authHeader: string;

    constructor(config: CoordinatorConfig) {
        this.config     = config;
        this.router     = new EvaluationRouter(config.evaluationUrls);
        this.authHeader = `Bearer ${config.internalApiKey}`;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    registerSession(sessionId: string, clip: ClipMetadata, sendFn: SendFn): void {
        const timer = this.startWindowTimer(sessionId);
        this.sessions.set(sessionId, {
            clip,
            sendFn,
            frames:         [],
            mfccs:          [],
            sequence:       0,
            clipScores:     [],
            lastResult:     null,
            lastTranscript: "",
            timer,
        });
    }

    deregisterSession(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        clearTimeout(state.timer);
        this.sessions.delete(sessionId);
        this.router.releaseSession(sessionId);
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
    }

    setClip(sessionId: string, clip: ClipMetadata): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        state.clip = clip;
    }

    async flushSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state || state.frames.length === 0) return;
        await this.dispatchWindow(sessionId, state, true);
    }

    async resetSession(sessionId: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        state.mfccs      = [];
        state.clipScores = [];

        try {
            await fetch(`${this.router.getUrl(sessionId)}/evaluate/reset/${sessionId}`, {
                method:  "POST",
                headers: { "Authorization": this.authHeader },
            });
        } catch {
            // Non-fatal — session continues regardless
        }
    }

    getClipAverageScore(sessionId: string): number | null {
        const state = this.sessions.get(sessionId);
        if (!state || state.clipScores.length === 0) return null;
        const sum = state.clipScores.reduce((a, b) => a + b, 0);
        return sum / state.clipScores.length;
    }

    getLastResult(sessionId: string): BehaviourResult | null {
        return this.sessions.get(sessionId)?.lastResult ?? null;
    }

    getLastTranscript(sessionId: string): string | null {
        const state = this.sessions.get(sessionId);
        if (!state || state.lastTranscript === "") return null;
        return state.lastTranscript;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private startWindowTimer(sessionId: string): NodeJS.Timeout {
        return setInterval(() => {
            const state = this.sessions.get(sessionId);
            if (!state) return;
            this.dispatchWindow(sessionId, state, false).catch(() => {});
        }, this.config.windowMs);
    }

    private async dispatchWindow(
        sessionId: string,
        state:     SessionState,
        force:     boolean,
    ): Promise<void> {
        if (!force && state.frames.length < this.config.minFramesPerWindow) {
            state.frames = [];
            state.mfccs  = [];
            return;
        }

        state.sequence++;
        const windowId = `${sessionId}:${state.sequence}`;

        const window: AnalysisWindow = {
            window_id:     windowId,
            session_id:    sessionId,
            frames:        state.frames,
            mfccs:         state.mfccs.flat(1),
            transcript:    "",
            clip_metadata: state.clip,
        };

        state.frames = [];
        state.mfccs  = [];

        try {
            const res = await fetch(`${this.router.getUrl(sessionId)}/evaluate/analyse`, {
                method:  "POST",
                headers: {
                    "Content-Type":  "application/json",
                    "Authorization": this.authHeader,
                },
                body: JSON.stringify(window),
            });

            if (!res.ok) return;

            const result      = await res.json() as BehaviourResult;
            state.clipScores.push(result.escalation_score);
            state.lastResult  = result;

            state.sendFn({
                type:             "session_update",
                session_id:       sessionId,
                window_id:        windowId,
                escalation_score: result.escalation_score,
                queue_position:   null,
            });
        } catch {}
    }
}