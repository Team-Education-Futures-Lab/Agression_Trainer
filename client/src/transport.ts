import type { VideoFrame, AudioChunk, ClientMessage, ServerMessage } from "@ar-training/shared";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TransportState = "disconnected" | "connecting" | "connected" | "error";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface TransportInterface {
    connect(sessionId: string): Promise<void>;
    disconnect(): void;
    sendFrame(frame: VideoFrame): void;
    sendAudio(chunk: AudioChunk): void;
    sendMessage(msg: ClientMessage): void;
    onMessage(cb: (msg: ServerMessage) => void): void;
    onStateChange(cb: (state: TransportState) => void): void;
}

// ─── WebSocketTransport ───────────────────────────────────────────────────────

export class WebSocketTransport implements TransportInterface {
    private readonly baseUrl: string;
    private ws: WebSocket | null = null;
    private messageHandler: ((msg: ServerMessage) => void) | null = null;
    private stateHandler:   ((state: TransportState) => void) | null = null;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl;
    }

    async connect(sessionId: string): Promise<void> {
        if (this.ws) {
            throw new Error("Transport already connected - call disconnect() first");
        }

        this.setState("connecting");

        return new Promise((resolve, reject) => {
            const url  = `${this.baseUrl}/ws/${sessionId}`;
            this.ws    = new WebSocket(url);

            this.ws.onopen = () => {
                this.setState("connected");
                resolve();
            };

            this.ws.onmessage = (e) => {
                try {
                    const msg: ServerMessage = JSON.parse(e.data);
                    this.messageHandler?.(msg);
                } catch {
                    console.error("[transport] Failed to parse server message:", e.data);
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

    disconnect(): void {
        if (!this.ws) return;
        this.ws.onclose = null;
        this.ws.close();
        this.ws = null;
        this.setState("disconnected");
    }

    sendFrame(frame: VideoFrame): void {
        this.send(frame);
    }

    sendAudio(chunk: AudioChunk): void {
        this.send(chunk);
    }

    sendMessage(msg: ClientMessage): void {
        this.send(msg);
    }

    onMessage(cb: (msg: ServerMessage) => void): void {
        this.messageHandler = cb;
    }

    onStateChange(cb: (state: TransportState) => void): void {
        this.stateHandler = cb;
    }

    private send(payload: VideoFrame | AudioChunk | ClientMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
        } else {
            console.warn("[transport] Dropped message — socket not open:", (payload as { type: string }).type);
        }
    }

    private setState(state: TransportState): void {
        this.stateHandler?.(state);
    }
}