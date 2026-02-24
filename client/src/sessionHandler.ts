import type {AudioChunk, CreateSessionResponse, ServerMessage, VideoFrame} from "@ar-training/shared";
import type {TransportInterface} from "./transport.ts";
import type {CaptureSession} from "./capture.ts";

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
    httpBase: string;
    userId: string;
    scenarioId: string;
    language: string;
}

// ─── SessionHandler ───────────────────────────────────────────────────────────

export class SessionHandler {
    private sessionId: string | null = null;
    private state: SessionHandlerState = "idle";
    private abortCtrl: AbortController | null = null;

    private stateHandler: ((state: SessionHandlerState) => void) | null = null;

    private readonly transport: TransportInterface;
    private readonly capture:   CaptureSession;
    private readonly options:   SessionHandlerOptions;

    constructor(
        transport: TransportInterface,
        capture:   CaptureSession,
        options: SessionHandlerOptions,
    ) {
        this.transport = transport;
        this.capture = capture;
        this.options = options;
    }

    onStateChange(cb: (state: SessionHandlerState) => void): void {
        this.stateHandler = cb;
    }

    onMessage(cb: (message: ServerMessage) => void): void {
        this.transport.onMessage(cb);
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    async connect(): Promise<void> {
        if (this.state !== "idle" && this.state !== "error") {
            throw new Error(`Cannot connect from state: ${this.state}`);
        }

        this.abortCtrl = new AbortController();
        this.setState("connecting");

        try {
            const res = await fetch(`${this.options.httpBase}/session/create`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    user_id: this.options.userId,
                    scenario_id: this.options.scenarioId,
                    language: this.options.language,
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
                await this.waitForQueue(data.session_id);
            }

            await this.transport.connect(data.session_id);

            this.transport.onStateChange(state => {
                if (state === "disconnected") this.setState("dropped");
                if (state === "error") this.setState("error");
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

    private setState(state: SessionHandlerState): void {
        this.state = state;
        this.stateHandler?.(state);
    }

    private async waitForQueue(session_id: string): Promise<void> {
        while (!this.abortCtrl?.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (this.abortCtrl?.signal.aborted) return;

            const res = await fetch(
                `${this.options.httpBase}/session/${session_id}/queue`,
                { signal: this.abortCtrl?.signal }
            );
            const data = await res.json();

            if (data.state === "active") return;
        }
    }

    private async runFrameLoop(session_id: string): Promise<void> {
        for await (const raw of this.capture.frames()) {
            if (this.abortCtrl?.signal.aborted) break;

            const frame: VideoFrame = {
                type: "video_frame",
                session_id: session_id,
                frame_id:       raw.frame_id,
                timestamp:      raw.timestamp,
                face_landmarks: raw.face_landmarks,
                left_hand:      raw.left_hand,
                right_hand:     raw.right_hand,
            };

            this.transport.sendFrame(frame);
        }
    }

    private async runAudioLoop(session_id: string): Promise<void> {
        for await (const raw of this.capture.audio()) {
            if (this.abortCtrl?.signal.aborted) return;

            const chunk: AudioChunk = {
                type:        "audio_chunk",
                session_id:  session_id,
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