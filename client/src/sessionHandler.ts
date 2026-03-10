import type { AudioChunk, ClipEnded, CreateSessionResponse, QueueStatusResponse, ServerMessage, VideoFrame } from "@ar-training/shared";
import type { TransportInterface } from "./transport.ts";
import type { CaptureSession } from "./capture.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionHandlerState =
    | "idle"
    | "connecting"
    | "queued"
    | "active"
    | "completed"
    | "dropped"
    | "error";

export interface SessionHandlerOptions {
    httpBase:   string;
    userId:     string;
    scenarioId: string;
    language:   string;
}

// ─── SessionHandler ───────────────────────────────────────────────────────────

export class SessionHandler {
    private sessionId: string | null = null;
    private state: SessionHandlerState = "idle";
    private abortCtrl: AbortController | null = null;

    private stateHandler:         ((state: SessionHandlerState) => void) | null = null;
    private queuePositionHandler: ((position: number) => void) | null = null;

    private readonly transport: TransportInterface;
    private readonly capture:   CaptureSession;
    private readonly options:   SessionHandlerOptions;

    constructor(
        transport: TransportInterface,
        capture:   CaptureSession,
        options:   SessionHandlerOptions,
    ) {
        this.transport = transport;
        this.capture   = capture;
        this.options   = options;
    }

    // ── Callbacks ─────────────────────────────────────────────────────────────

    onStateChange(cb: (state: SessionHandlerState) => void): void {
        this.stateHandler = cb;
    }

    /** Fires each time a queue-position poll returns a position, including
     *  the initial position from POST /session/create. */
    onQueuePosition(cb: (position: number) => void): void {
        this.queuePositionHandler = cb;
    }

    onMessage(cb: (message: ServerMessage) => void): void {
        this.transport.onMessage(cb);
    }

    // ── Accessors ─────────────────────────────────────────────────────────────

    getSessionId(): string | null {
        return this.sessionId;
    }

    getState(): SessionHandlerState {
        return this.state;
    }

    // ── Actions ───────────────────────────────────────────────────────────────

    sendClipEnded(clipId: string): void {
        const sessionId = this.sessionId;
        if (!sessionId) {
            console.warn("[session] sendClipEnded called with no active session");
            return;
        }
        const msg: ClipEnded = { type: "clip_ended", session_id: sessionId, clip_id: clipId };
        this.transport.sendMessage(msg);
    }

    async connect(): Promise<void> {
        if (this.state !== "idle" && this.state !== "error") {
            throw new Error(`Cannot connect from state: ${this.state}`);
        }

        this.abortCtrl = new AbortController();
        this.setState("connecting");

        try {
            const res = await fetch(`${this.options.httpBase}/session/create`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    user_id:     this.options.userId,
                    scenario_id: this.options.scenarioId,
                    language:    this.options.language,
                }),
                signal: this.abortCtrl.signal,
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.message ?? `HTTP ${res.status}`);
            }

            const data: CreateSessionResponse = await res.json();
            this.sessionId = data.session_id;

            if (data.state === "queued") {
                this.setState("queued");
                if (data.queue_position != null) {
                    this.queuePositionHandler?.(data.queue_position);
                }
                await this.waitForQueue(data.session_id);
            }

            await this.transport.connect(data.session_id);

            this.transport.onStateChange(state => {
                if (state === "disconnected") this.setState("dropped");
                if (state === "error")        this.setState("error");
            });

            this.setState("active");

            // noinspection ES6MissingAwait
            this.runFrameLoop(data.session_id);
            // noinspection ES6MissingAwait
            this.runAudioLoop(data.session_id);

        } catch (e: unknown) {
            if ((e as Error).name === "AbortError") return;
            this.setState("error");
            throw e;
        }
    }

    disconnect(): void {
        this.abortCtrl?.abort();
        this.transport.disconnect();
        this.sessionId = null;
        this.setState("idle");
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private setState(state: SessionHandlerState): void {
        this.state = state;
        this.stateHandler?.(state);
    }

    private async waitForQueue(sessionId: string): Promise<void> {
        while (!this.abortCtrl?.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (this.abortCtrl?.signal.aborted) return;

            const res = await fetch(
                `${this.options.httpBase}/session/${sessionId}/queue`,
                { signal: this.abortCtrl?.signal },
            );
            const data: QueueStatusResponse = await res.json();

            if (data.state === "active") return;

            if (data.queue_position != null) {
                this.queuePositionHandler?.(data.queue_position);
            }
        }
    }

    private async runFrameLoop(sessionId: string): Promise<void> {
        for await (const raw of this.capture.frames()) {
            if (this.abortCtrl?.signal.aborted) break;

            const frame: VideoFrame = {
                type:           "video_frame",
                session_id:     sessionId,
                frame_id:       raw.frame_id,
                timestamp:      raw.timestamp,
                face_landmarks: raw.face_landmarks,
                left_hand:      raw.left_hand,
                right_hand:     raw.right_hand,
            };

            this.transport.sendFrame(frame);
        }
    }

    private async runAudioLoop(sessionId: string): Promise<void> {
        for await (const raw of this.capture.audio()) {
            if (this.abortCtrl?.signal.aborted) return;

            const chunk: AudioChunk = {
                type:        "audio_chunk",
                session_id:  sessionId,
                chunk_id:    raw.chunk_id,
                timestamp:   raw.timestamp,
                pcm:         raw.pcm,
                sample_rate: raw.sample_rate,
                mfccs:       raw.mfccs,
            };

            this.transport.sendAudio(chunk);
        }
    }
}