// =============================================================================
// SessionHandler
//
// Manages the full client-side session lifecycle. Consumes RawVideoFrame and
// RawAudioChunk from CaptureSession, stamps them with session_id, and sends
// them over the transport. Handles all inbound ServerMessages and drives state
// transitions as defined in docs/session_lifecycle.md.
//
// State machine (client-side view):
//
//   idle
//     → connecting   connect() called, POST /session/create succeeded
//     → queued       server responded state=queued, polling starts
//     → connecting   poll returned state=active, opening WebSocket
//     → active       WebSocket open, frame/audio loops running
//     → paused       sendClipEnded() called, loops stopped, awaiting ClipReady
//     → active       ClipReady received with non-null next_clip_id
//     → completed    ClipReady received with null next_clip_id
//     → dropped      WebSocket closed unexpectedly
//     → error        unrecoverable (503, resume 404, etc.)
//   any → idle       disconnect() called
// =============================================================================

import type {
    SessionState,
    ServerMessage,
    VideoFrame,
    AudioChunk,
} from "@ar-training/shared";
import type { CaptureSession } from "./capture.ts";
import { WebSocketTransport } from "./transport.ts";
import type { TransportInterface } from "./transport.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const QUEUE_POLL_INTERVAL_MS = 5000;

const HTTP_BASE = import.meta.env["VITE_APP_HTTP_URL"] as string | undefined
    ?? "http://localhost:3001";
const WS_BASE   = import.meta.env["VITE_APP_WS_URL"] as string | undefined
    ?? "ws://localhost:3001";
const SCENARIO_ID = import.meta.env["VITE_SCENARIO_ID"] as string | undefined
    ?? "scenario_01";

// ─── Callbacks ────────────────────────────────────────────────────────────────

export interface SessionHandlerCallbacks {
    onStateChange: (state: SessionState) => void;
    onMessage:     (msg: ServerMessage)  => void;
    onError:       (err: Error)          => void;
}

// ─── SessionHandler ───────────────────────────────────────────────────────────

export class SessionHandler {
    private readonly capture:   CaptureSession;
    private readonly callbacks: SessionHandlerCallbacks;

    private _state: SessionState = "idle";

    private sessionId:  string | null = null;
    private transport:  TransportInterface | null = null;
    private pollTimer:  ReturnType<typeof setInterval> | null = null;

    // Per-clip counters — reset when a new clip begins
    private frameId = 0;
    private chunkId = 0;
    private clipStartTime = 0;

    // Loop cancellation — set to true to stop the running loops
    private loopsCancelled = false;

    constructor(capture: CaptureSession, callbacks: SessionHandlerCallbacks) {
        this.capture   = capture;
        this.callbacks = callbacks;
    }

    get state(): SessionState { return this._state; }
    get currentSessionId(): string | null { return this.sessionId; }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Create a session and open the WebSocket. If the server is at capacity
     * the handler enters the queued state and polls until a slot is available.
     */
    async connect(userId = "dev-user", scenarioId = SCENARIO_ID, language = "nl"): Promise<void> {
        if (this._state !== "idle") return;

        this._setState("connecting");

        let sessionId: string;
        let initialState: "active" | "queued";
        let queuePosition: number | undefined;

        try {
            const res = await fetch(`${HTTP_BASE}/session/create`, {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body:    JSON.stringify({ user_id: userId, scenario_id: scenarioId, language }),
            });

            if (res.status === 503) {
                this._setState("error");
                this.callbacks.onError(new Error("Server at capacity — try again later"));
                return;
            }
            if (!res.ok) {
                this._setState("error");
                this.callbacks.onError(new Error(`Session create failed: ${res.status}`));
                return;
            }

            const body = await res.json() as {
                session_id: string;
                state: "active" | "queued";
                queue_position?: number;
            };
            sessionId     = body.session_id;
            initialState  = body.state;
            queuePosition = body.queue_position;
        } catch (e) {
            this._setState("error");
            this.callbacks.onError(new Error(`Session create error: ${String(e)}`));
            return;
        }

        this.sessionId = sessionId;

        if (initialState === "queued") {
            this._setState("queued");
            // Fire an initial onMessage so the UI has the queue position immediately.
            this.callbacks.onMessage({
                type:           "session_update",
                session_id:     sessionId,
                transcript:     "",
                queue_position: queuePosition ?? null,
            });
            this._startQueuePolling();
            return;
        }

        await this._openWebSocket();
    }

    /**
     * Signal that the current clip has finished playing. Stops the frame and
     * audio loops and sends a ClipEnded message. The handler enters paused
     * state and waits for ClipReady.
     */
    sendClipEnded(clipId: string): void {
        if (this._state !== "active" || !this.transport || !this.sessionId) return;

        this.loopsCancelled = true;
        this._setState("paused");

        this.transport.send({
            type:       "clip_ended",
            session_id: this.sessionId,
            clip_id:    clipId,
        });
    }

    /**
     * Disconnect intentionally. Calls POST /session/{id}/end, closes the
     * WebSocket, and returns to idle.
     */
    disconnect(): void {
        this._stopQueuePolling();
        this.loopsCancelled = true;

        if (this.sessionId) {
            // Fire-and-forget — we don't await this
            void fetch(`${HTTP_BASE}/session/${this.sessionId}/end`, { method: "POST" })
                .catch(() => undefined);
        }

        this.transport?.close();
        this.transport = null;
        this.sessionId = null;
        this._setState("idle");
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    private async _openWebSocket(): Promise<void> {
        this._setState("connecting");

        const url = `${WS_BASE}/ws/${this.sessionId!}`;
        let transport: WebSocketTransport;

        try {
            transport = await WebSocketTransport.connect(url);
        } catch (e) {
            this._setState("error");
            this.callbacks.onError(new Error(`WebSocket connection failed: ${String(e)}`));
            return;
        }

        transport.onMessage = (msg) => { this._handleServerMessage(msg); };
        transport.onClose   = (clean) => { this._handleClose(clean); };
        transport.onError   = (err)   => { this.callbacks.onError(err); };

        this.transport = transport;
        this._startClip();
    }

    private _handleServerMessage(msg: ServerMessage): void {
        this.callbacks.onMessage(msg);

        switch (msg.type) {
            case "clip_ready":
                if (msg.next_clip_id !== null) {
                    // Reset per-clip counters and restart loops for the next clip.
                    this._startClip();
                } else {
                    // Terminal clip — wait for FeedbackToken / SessionComplete.
                    this._setState("completed");
                }
                break;

            case "session_complete":
                // Feedback generation finished — close cleanly.
                this.transport?.close();
                this.transport = null;
                this.sessionId = null;
                this._setState("idle");
                break;

            case "error":
                this.callbacks.onError(new Error(`[${msg.code}] ${msg.message}`));
                break;

            // session_update and feedback_token are forwarded to onMessage above
            // and require no state transitions here.
        }
    }

    private _handleClose(clean: boolean): void {
        if (clean) return; // intentional close — state already set by disconnect()
        if (this._state === "completed" || this._state === "idle") return;
        this.loopsCancelled = true;
        this._setState("dropped");
    }

    // ─── Clip lifecycle ───────────────────────────────────────────────────────

    /** Reset per-clip state and start sending frames and audio. */
    private _startClip(): void {
        this.frameId       = 0;
        this.chunkId       = 0;
        this.clipStartTime = performance.now();
        this.loopsCancelled = false;

        this._setState("active");
        this._runFrameLoop();
        this._runAudioLoop();
    }

    // ─── Frame loop ───────────────────────────────────────────────────────────

    private _runFrameLoop(): void {
        void (async () => {
            for await (const raw of this.capture.frames()) {
                if (this.loopsCancelled) break;
                if (this._state !== "active") break;
                if (!this.transport || !this.sessionId) break;

                const frame: VideoFrame = {
                    type:           "video_frame",
                    session_id:     this.sessionId,
                    frame_id:       this.frameId++,
                    timestamp:      (performance.now() - this.clipStartTime) / 1000,
                    face_landmarks: raw.face_landmarks,
                    left_hand:      raw.left_hand,
                    right_hand:     raw.right_hand,
                };

                try {
                    this.transport.send(frame);
                } catch (e) {
                    this.callbacks.onError(new Error(`Frame send failed: ${String(e)}`));
                    break;
                }
            }
        })();
    }

    // ─── Audio loop ───────────────────────────────────────────────────────────

    private _runAudioLoop(): void {
        void (async () => {
            for await (const raw of this.capture.audio()) {
                if (this.loopsCancelled) break;
                if (this._state !== "active") break;
                if (!this.transport || !this.sessionId) break;

                const chunk: AudioChunk = {
                    type:        "audio_chunk",
                    session_id:  this.sessionId,
                    chunk_id:    this.chunkId++,
                    timestamp:   (performance.now() - this.clipStartTime) / 1000,
                    pcm:         raw.pcm,
                    sample_rate: raw.sample_rate,
                    mfccs:       raw.mfccs,
                };

                try {
                    this.transport.send(chunk);
                } catch (e) {
                    this.callbacks.onError(new Error(`Audio send failed: ${String(e)}`));
                    break;
                }
            }
        })();
    }

    // ─── Queue polling ────────────────────────────────────────────────────────

    private _startQueuePolling(): void {
        this.pollTimer = setInterval(() => { void this._pollQueue(); }, QUEUE_POLL_INTERVAL_MS);
    }

    private _stopQueuePolling(): void {
        if (this.pollTimer !== null) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private async _pollQueue(): Promise<void> {
        if (!this.sessionId) return;

        try {
            const res = await fetch(`${HTTP_BASE}/session/${this.sessionId}/queue`);
            if (!res.ok) {
                this._stopQueuePolling();
                this._setState("error");
                this.callbacks.onError(new Error(`Queue poll failed: ${res.status}`));
                return;
            }

            const body = await res.json() as {
                state: "queued" | "active";
                queue_position: number | null;
            };

            if (body.state === "queued") {
                // Still waiting — update the UI with the latest position.
                this.callbacks.onMessage({
                    type:           "session_update",
                    session_id:     this.sessionId,
                    transcript:     "",
                    queue_position: body.queue_position,
                });
                return;
            }

            // Slot became available.
            this._stopQueuePolling();
            await this._openWebSocket();
        } catch (e) {
            this._stopQueuePolling();
            this._setState("error");
            this.callbacks.onError(new Error(`Queue poll error: ${String(e)}`));
        }
    }

    // ─── State ────────────────────────────────────────────────────────────────

    private _setState(state: SessionState): void {
        if (this._state === state) return;
        this._state = state;
        this.callbacks.onStateChange(state);
    }
}
