import type {AudioChunk, ServerMessage, VideoFrame} from "@ar-training/shared"

// ─── Types ────────────────────────────────────────────────────────────────────

export type TransportState = "disconnected" | "connecting" | "connected" | "error";

// ─── Interface ────────────────────────────────────────────────────────────────
// All transport communication goes through this interface.
// Swap WebSocketTransport for a WebRTC or gRPC implementation
// without changing anything else in the system.

export interface TransportInterface {
    connect(sessionId: string): Promise<void>;
    disconnect(): void;
    sendFrame(frame: VideoFrame): void;
    sendAudio(chunk: AudioChunk): void;
    onMessage(cb: (msg: ServerMessage) => void): void;
    onStateChange(cb: (state: TransportState) => void): void;
}

// ─── WebSocketTransport ───────────────────────────────────────────────────────

export class WebSocketTransport implements TransportInterface {
    private readonly baseUrl: string;
    private ws: WebSocket | null = null;
    private messageHandler: ((msg: ServerMessage) => void) | null = null;
    private stateHandler: ((state: TransportState) => void) | null = null;

    constructor(baseUrl: string) { this.baseUrl = baseUrl; }

    connect(sessionId: string): Promise<void> {
        if (this.ws) {
            throw new Error("Transport already connected - call disconnect() first");
        }

        this.setState("connecting");

        return new Promise((resolve, reject) => {
            const url = `${this.baseUrl}/ws/${sessionId}`;
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this.setState("connected");
                resolve();
            };

            this.ws.onmessage = (event: MessageEvent) => {
                try {
                    const msg: ServerMessage = JSON.parse(event.data);
                    this.messageHandler?.(msg);
                } catch {
                    console.error("[transport] Failed to parse server message: ", event.data);
                }
            };

            this.ws.onerror = () => {
                reject(new Error(`WebSocket error connecting to ${url}`));
            };

            this.ws.onclose = () => {
                this.ws = null;
                this.setState("disconnected");
            };
        });
    }

    disconnect() {
        if (!this.ws) return;

        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
        this.setState("disconnected");
    }

    sendFrame(frame: VideoFrame) {
        this.send(frame);
    }

    sendAudio(chunk: AudioChunk) {
        this.send(chunk);
    }

    onMessage(cb: (msg: ServerMessage) => void) {
        this.messageHandler = cb;
    }

    onStateChange(cb: (state: TransportState) => void) {
        this.stateHandler = cb;
    }

    // ── Private ─────────────────────────────────────────────────────────────────

    private send(payload: VideoFrame | AudioChunk): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.warn("[transport] Dropped message — socket not open:", payload.type);
        }
    }

    private setState(state: TransportState): void {
        this.stateHandler?.(state);
    }
}