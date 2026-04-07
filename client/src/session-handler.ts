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
//     → connecting   connect() called, POST /session/create in-flight
//     → queued       server responded state=queued; WS opened, waiting session_ready
//     → connecting   session_ready received
//     → selecting    scenarios_list received; waiting for selectScenario()
//     → active       selectScenario() called → request_clip sent → clip_data received
//     → paused       sendClipEnded() called, loops stopped, awaiting clip_selected
//     → active       clip_selected received with non-null clip_id
//     → completed    clip_selected received with null clip_id
//     → dropped      WebSocket closed unexpectedly while connecting/selecting/active/paused
//     → error        unrecoverable (503, resume 404, etc.)
//   any → idle       disconnect() called
// =============================================================================

import type {
    SessionState,
    ServerMessage,
    VideoFrame,
    AudioChunk,
    ClipData,
    ClipCandidateData,
} from "@ar-training/shared";
import type { CaptureSession } from "./capture.ts";
import { WebSocketTransport } from "./transport.ts";
import type { TransportInterface } from "./transport.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const HTTP_BASE = import.meta.env["VITE_APP_HTTP_URL"] as string | undefined
    ?? "http://localhost:3001";
const WS_BASE = import.meta.env["VITE_APP_WS_URL"] as string | undefined
    ?? "ws://localhost:3001";

// ─── Callbacks ────────────────────────────────────────────────────────────────

export interface SessionHandlerCallbacks {
    onStateChange:        (state: SessionState) => void;
    onMessage:            (msg: ServerMessage)  => void;
    onError:              (err: Error)          => void;
    /** Called only when clip_data arrives for an activating request_clip. */
    onActivatingClipData: (msg: ClipData)       => void;
}

// ─── SessionHandler ───────────────────────────────────────────────────────────

export class SessionHandler {
    private readonly capture:   CaptureSession;
    private readonly callbacks: SessionHandlerCallbacks;

    private _state: SessionState = "idle";

    private sessionId: string | null = null;
    private transport: TransportInterface | null = null;

    // Whether the session was created with an admin API key.
    private _isAdmin = false;

    // Set to true by disconnect() so subsequent WebSocket close events are ignored.
    private _clean = false;

    // Per-clip counters — reset when a new clip begins
    private frameId       = 0;
    private chunkId       = 0;
    private clipStartTime = 0;

    // Loop cancellation — set to true to stop the running loops
    private loopsCancelled = false;

    constructor(capture: CaptureSession, callbacks: SessionHandlerCallbacks) {
        this.capture   = capture;
        this.callbacks = callbacks;
    }

    get state(): SessionState { return this._state; }
    get currentSessionId(): string | null { return this.sessionId; }
    get isAdmin(): boolean { return this._isAdmin; }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Create a session and open the WebSocket. If the server is at capacity
     * the handler enters the queued state and waits for session_ready over the
     * WebSocket rather than polling.
     *
     * When `adminKey` is provided it is sent as `Authorization: Bearer <key>`
     * on the POST /session/create request. The resulting session is an admin
     * session: any clip can be activated, and the server sends `debug_eval`
     * messages after each `clip_selected`. When empty/undefined the request
     * is unauthenticated and a normal session is created.
     */
    async connect(userId = "dev-user", language = "nl", adminKey?: string): Promise<void> {
        if (this._state !== "idle") return;

        this._clean   = false;
        this._isAdmin = false;
        this._setState("connecting");

        let sessionId: string;
        let initialState: "active" | "queued";
        let queuePosition: number | undefined;
        let wsPath: string;

        try {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (adminKey) headers["Authorization"] = `Bearer ${adminKey}`;

            const res = await fetch(`${HTTP_BASE}/session/create`, {
                method:  "POST",
                headers,
                body:    JSON.stringify({ user_id: userId, language }),
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
                session_id:     string;
                state:          "active" | "queued";
                ws_path:        string;
                queue_position?: number;
            };
            sessionId     = body.session_id;
            initialState  = body.state;
            wsPath        = body.ws_path;
            queuePosition = body.queue_position;

            // Record admin mode if a key was provided and the session was accepted.
            if (adminKey) this._isAdmin = true;
        } catch (e) {
            this._setState("error");
            this.callbacks.onError(new Error(`Session create error: ${String(e)}`));
            return;
        }

        this.sessionId = sessionId;

        // Open the WebSocket immediately regardless of active/queued state.
        // For queued sessions we wait for session_ready before proceeding.
        if (initialState === "queued") {
            this._setState("queued");
            // Emit an initial session_update so the UI has the queue position.
            this.callbacks.onMessage({
                type:           "session_update",
                session_id:     sessionId,
                transcript:     "",
                queue_position: queuePosition ?? null,
            });
        }

        await this._openWebSocket(wsPath);
    }

    /**
     * Request scenarios from the server. Sent automatically after the
     * WebSocket is open and the session is active (or promoted from queued).
     * Exposed publicly so the debug harness can re-request at any time.
     */
    requestScenarios(): void {
        if (!this.transport || !this.sessionId) return;
        this.transport.send({ type: "get_scenarios", session_id: this.sessionId });
    }

    /**
     * Select a scenario and activate its entry clip. Starts the capture loops.
     * The session transitions from selecting → active once clip_data is received.
     */
    selectScenario(scenarioId: string, entryClipId: string): void {
        if (this._state !== "selecting" || !this.transport || !this.sessionId) return;
        this._requestClip(scenarioId, entryClipId, true);
    }

    /**
     * Request clip data without activating it (preload only). Valid at any
     * point after the WebSocket is open. Does not change session state.
     */
    preloadClip(scenarioId: string, clipId: string): void {
        if (!this.transport || !this.sessionId) return;
        this._requestClip(scenarioId, clipId, false);
    }

    /**
     * Signal that the current clip has finished playing. Stops the frame and
     * audio loops and sends a ClipEnded message. The handler enters paused
     * state and waits for clip_selected.
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
     * WebSocket, and returns to idle. Subsequent close events from the
     * WebSocket are ignored via the _clean flag.
     */
    disconnect(): void {
        this._clean     = true;
        this._isAdmin   = false;
        this.loopsCancelled = true;

        if (this.sessionId) {
            void fetch(`${HTTP_BASE}/session/${this.sessionId}/end`, { method: "POST" })
                .catch(() => undefined);
        }

        this.transport?.close();
        this.transport  = null;
        this.sessionId  = null;
        this._setState("idle");
    }

    // ─── WebSocket ────────────────────────────────────────────────────────────

    private async _openWebSocket(wsPath: string): Promise<void> {
        const url = `${WS_BASE}${wsPath}`;
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

        // If we are already in the active state (non-queued session), request
        // scenarios immediately. If queued, wait for session_ready.
        if (this._state === "connecting") {
            this.requestScenarios();
        }
        // state === "queued" → do nothing here; session_ready fires requestScenarios
    }

    private _handleServerMessage(msg: ServerMessage): void {
        this.callbacks.onMessage(msg);

        switch (msg.type) {
            case "session_ready":
                // Queued session promoted — request scenarios and proceed.
                this._setState("connecting");
                this.requestScenarios();
                break;

            case "scenarios_list":
                // Scenarios received — client can now pick one.
                this._setState("selecting");
                break;

            case "clip_data":
                // An activating clip_data only arrives in two situations:
                //   1. selectScenario() — first clip of a session (state: selecting)
                //   2. The request_clip fallback in clip_selected (state: connecting)
                // Preload-only clip_data arrives while active/paused and must not
                // start loops.
                if (this._state === "selecting" || this._state === "connecting") {
                    this.callbacks.onActivatingClipData(msg);
                    this._startClip();
                }
                break;

            case "clip_candidates":
                // Store candidates so clip_selected can resolve without a round-trip.
                this._lastCandidates = msg.candidates;
                break;

            case "clip_selected":
                if (msg.clip_id !== null) {
                    // The winning clip's full data is already in _lastCandidates —
                    // the server sent it as part of clip_candidates before evaluation
                    // ran. Use it directly instead of sending another request_clip,
                    // which the server would reject (session is already ACTIVE).
                    const candidate = this._lastCandidates.find(c => c.clip_id === msg.clip_id);
                    if (candidate && this._activeScenarioId) {
                        // Synthesise a ClipData message from the candidate.
                        const clipData: ClipData = {
                            type:              "clip_data",
                            session_id:        this.sessionId!,
                            clip_id:           candidate.clip_id,
                            scenario_id:       this._activeScenarioId,
                            video_url:         candidate.video_url,
                            transcript:        candidate.transcript,
                            notable_features:  candidate.notable_features,
                            branch_conditions: candidate.branch_conditions,
                        };
                        this._lastCandidates = [];
                        this.callbacks.onActivatingClipData(clipData);
                        this._startClip();
                    } else {
                        // Candidate not found (shouldn't happen in normal flow) —
                        // fall back to a request_clip round-trip.
                        this._lastCandidates = [];
                        if (this._activeScenarioId) {
                            this._requestClip(this._activeScenarioId, msg.clip_id, true);
                        }
                    }
                } else {
                    // Terminal clip — session is complete, waiting for feedback.
                    this._lastCandidates = [];
                    this._setState("completed");
                }
                break;

            case "debug_eval":
                // Admin-only message: forwarded to the callback for UI handling.
                // No state machine changes — it is purely supplementary data.
                break;

            case "session_complete":
                // Feedback done — leave in completed state; caller calls disconnect().
                break;

            case "error":
                // feedback_unavailable is not fatal — session is complete otherwise.
                if (msg.code === "feedback_unavailable") break;
                this.callbacks.onError(new Error(`[${msg.code}] ${msg.message}`));
                break;
        }
    }

    private _handleClose(clean: boolean): void {
        // Ignore close events after an intentional disconnect().
        if (this._clean) return;
        // A clean close (normal handshake) does not indicate an unexpected drop.
        if (clean) return;
        // Do not transition to dropped from terminal or already-idle states.
        if (
            this._state === "completed" ||
            this._state === "idle"      ||
            this._state === "error"
        ) return;

        this.loopsCancelled = true;
        this._setState("dropped");
    }

    // ─── Clip helpers ─────────────────────────────────────────────────────────

    /** Scenario ID for the active session — set by selectScenario(). */
    private _activeScenarioId: string | null = null;

    /** Last clip_candidates received — used to resolve clip_selected without a round-trip. */
    private _lastCandidates: ClipCandidateData[] = [];

    private _requestClip(scenarioId: string, clipId: string, activate: boolean): void {
        if (!this.transport || !this.sessionId) return;
        if (activate) this._activeScenarioId = scenarioId;
        this.transport.send({
            type:        "request_clip",
            session_id:  this.sessionId,
            scenario_id: scenarioId,
            clip_id:     clipId,
            activate,
        });
    }

    // ─── Clip lifecycle ───────────────────────────────────────────────────────

    /** Reset per-clip state and start sending frames and audio. */
    private _startClip(): void {
        this.frameId        = 0;
        this.chunkId        = 0;
        this.clipStartTime  = performance.now();
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

    // ─── State ────────────────────────────────────────────────────────────────

    private _setState(state: SessionState): void {
        if (this._state === state) return;
        this._state = state;
        this.callbacks.onStateChange(state);
    }
}