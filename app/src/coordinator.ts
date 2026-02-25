import type {
    VideoFrame,
    AudioChunk,
    ClipMetadata,
    ServerMessage,
    AnalysisWindow,
    BehaviourResult, FeedbackRequest, FeedbackToken, SessionComplete
} from "@ar-training/shared";
import type { CoordinatorConfig } from "./types.js";
import {clearTimeout} from "node:timers";

export type SendFn = (message: ServerMessage) => void;

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionState {
    clip:            ClipMetadata;
    sendFn:          SendFn;
    frames:          VideoFrame[];
    mfccs:           number[][][];
    sequence:        number;
    clipScores:      number[];
    timer:           NodeJS.Timeout;
}

// ─── Coordinator ──────────────────────────────────────────────────────────────
export class Coordinator {
    private readonly config: CoordinatorConfig;
    private readonly sessions: Map<string, SessionState> = new Map();

    constructor(config: CoordinatorConfig) {
        this.config = config;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    registerSession(sessionId: string, clip: ClipMetadata, sendFn: SendFn): void {
        const timer = this.startWindowTimer(sessionId);
        this.sessions.set(sessionId, {
            clip,
            sendFn,
            frames: [],
            mfccs: [],
            sequence: 0,
            clipScores: [],
            timer,
        });
    }

    deregisterSession(sessionId: string): void {
        const state = this.sessions.get(sessionId);
        if (!state) return;
        clearTimeout(state.timer);
        this.sessions.delete(sessionId);
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
            await fetch(`${this.config.evaluationUrl}/evaluate/reset/${sessionId}`, {
                method: "POST",
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

    async streamFeedback(sessionId: string, feedbackReq: FeedbackRequest, feedbackUrl: string): Promise<void> {
        const state = this.sessions.get(sessionId);
        if (!state) return;

        const res = await fetch(`${feedbackUrl}/feedback/generate/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(feedbackReq),
        });

        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const {done, value} = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const json = line.slice(6).trim();
                if (!json) continue;

                try {
                    const event = JSON.parse(json) as { type: string; token?: string; feedback?: object };

                    if (event.type === "token") {
                        const msg: FeedbackToken = {
                            type:       "feedback_token",
                            session_id: sessionId,
                            token:      event.token ?? "",
                        };
                        state.sendFn(msg);

                    } else if (event.type === "complete") {
                        const fb = event.feedback as { advice: string; severity: "low" | "medium" | "high"; highlights: string[] };
                        const msg: SessionComplete = {
                            type:       "session_complete",
                            session_id: sessionId,
                            advice:     fb.advice,
                            severity:   fb.severity,
                            highlights: fb.highlights,
                        };
                        state.sendFn(msg);
                    }
                } catch {
                    // Malformed SSE event — skip and continue
                }
            }
        }
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
        state: SessionState,
        force: boolean,
    ): Promise<void> {
        if (!force && state.frames.length < this.config.minFramesPerWindow) {
            state.frames = [];
            state.mfccs = [];
            return;
        }

        state.sequence++;
        const windowId = `${sessionId}:${state.sequence}`;

        const window: AnalysisWindow = {
            window_id: windowId,
            session_id: sessionId,
            frames: state.frames,
            mfccs: state.mfccs.flat(1),
            transcript: "",
            clip_metadata: state.clip,
        };

        state.frames = [];
        state.mfccs = [];

        try {
            const res = await fetch(`${this.config.evaluationUrl}/evaluate/analyse`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(window),
            });

            if (!res.ok) return;

            const result = await res.json() as BehaviourResult;
            state.clipScores.push(result.escalation_score);

            state.sendFn({
                type: "session_update",
                session_id: sessionId,
                window_id: windowId,
                escalation_score: result.escalation_score,
                queue_position: null,
            });
        } catch {}
    }
}