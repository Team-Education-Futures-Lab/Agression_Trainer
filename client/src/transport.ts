// =============================================================================
// Transport
//
// TransportInterface abstracts the WebSocket connection so SessionHandler
// never touches the WebSocket API directly. WebSocketTransport is the
// production implementation.
// =============================================================================

import type { ClientMessage, ServerMessage } from "@ar-training/shared";

// ─── Interface ────────────────────────────────────────────────────────────────

export interface TransportInterface {
    /** Send a client-to-server message. Throws if the connection is not open. */
    send(msg: ClientMessage): void;

    /** Close the connection intentionally (e.g. user disconnect). */
    close(): void;

    /** Called for every well-formed ServerMessage received. */
    onMessage: ((msg: ServerMessage) => void) | null;

    /**
     * Called when the connection closes. `clean` is true when close() was
     * called by this client, false for unexpected drops.
     */
    onClose: ((clean: boolean) => void) | null;

    /** Called when a message cannot be parsed or a send fails. */
    onError: ((err: Error) => void) | null;

    /**
     * Called when a `heartbeat` message is received from the server.
     * Heartbeat messages are filtered out of `onMessage` — they are a
     * transport-layer concern and must not reach the application layer.
     *
     * `status` is the `status` field of the heartbeat:
     *   - `"feedback_generating"` — the server is streaming feedback from Ollama
     *   - `"ok"`                  — general keepalive (reserved for future use)
     *
     * The browser responds to server-side WebSocket protocol pings automatically
     * with pong frames — no code is needed here for that path.
     */
    onHeartbeat: ((status: string) => void) | null;
}

// ─── WebSocketTransport ───────────────────────────────────────────────────────

export class WebSocketTransport implements TransportInterface {
    onMessage:   ((msg: ServerMessage) => void) | null = null;
    onClose:     ((clean: boolean) => void) | null     = null;
    onError:     ((err: Error) => void) | null         = null;
    onHeartbeat: ((status: string) => void) | null     = null;

    private ws: WebSocket;
    private _clean = false;

    constructor(url: string) {
        this.ws = new WebSocket(url);

        this.ws.onmessage = (ev: MessageEvent<string>) => {
            let parsed: ServerMessage;
            try {
                parsed = JSON.parse(ev.data) as ServerMessage;
            } catch (e) {
                this.onError?.(new Error(`Failed to parse server message: ${String(e)}`));
                return;
            }

            // HeartbeatMessage is in the ServerMessage union so that server-side
            // code can pass it to SendFn in a type-safe way. On the client it is
            // a transport-layer signal: filter it here before the application layer
            // sees it, and route it exclusively to onHeartbeat. Application code
            // that processes ServerMessage values via onMessage will never receive
            // a heartbeat message.
            if (parsed.type === "heartbeat") {
                this.onHeartbeat?.(parsed.status);
                return;
            }

            this.onMessage?.(parsed);
        };

        this.ws.onclose = () => {
            this.onClose?.(this._clean);
        };

        this.ws.onerror = () => {
            // The WebSocket API gives no useful detail in onerror — the close
            // event that follows immediately will carry the actual reason.
            this.onError?.(new Error("WebSocket error"));
        };
    }

    /**
     * Returns a Promise that resolves once the WebSocket reaches OPEN state,
     * or rejects if the connection fails before opening.
     */
    static connect(url: string): Promise<WebSocketTransport> {
        return new Promise((resolve, reject) => {
            const t = new WebSocketTransport(url);
            if (t.ws.readyState === WebSocket.OPEN) {
                resolve(t);
                return;
            }
            t.ws.onopen = () => resolve(t);
            // Override the instance onerror just for the connection phase.
            // Once open, the instance handlers take over.
            const origOnError = t.ws.onerror;
            t.ws.onerror = (ev) => {
                origOnError?.call(t.ws, ev);
                reject(new Error("WebSocket connection failed"));
            };
        });
    }

    send(msg: ClientMessage): void {
        if (this.ws.readyState !== WebSocket.OPEN) {
            throw new Error(`Cannot send — WebSocket state is ${this.ws.readyState}`);
        }
        this.ws.send(JSON.stringify(msg));
    }

    close(): void {
        this._clean = true;
        this.ws.close();
    }
}