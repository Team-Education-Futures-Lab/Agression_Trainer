# API Contract

Defines the exact wire format for all communication between the browser client and the App container. All HTTP bodies are JSON unless stated otherwise. All WebSocket messages are JSON frames unless stated otherwise.

This document is the source of truth for the **client-facing** interface. If a TypeScript type definition and this document conflict, this document takes precedence.

> **Internal and tooling APIs** — the inter-container APIs (App→Transcription, App→Evaluation, App→Feedback), the health endpoint, admin session creation, and debugging endpoints are documented separately in `admin_and_tooling_api.md`.
>
> **Authentication** — user accounts, JWT issuance, and the `/auth/*` endpoints are documented in `auth.md`.

---

## HTTP — Session Management

### `POST /session/create`

Creates a session slot. The scenario is not required at creation time — it is
bound later via `request_clip` with `activate: true` over the WebSocket.

**Request**
```json
{
    "user_id": "string",
    "language": "string  // ISO 639-1, e.g. 'nl'"
}
```

**Response 200 — session created**
```json
{
    "session_id": "string  // UUID",
    "state": "active",
    "ws_path": "string  // e.g. '/ws/{session_id}'"
}
```

**Response 200 — session queued**
```json
{
    "session_id": "string",
    "state": "queued",
    "ws_path": "string",
    "queue_position": "integer  // 1-indexed"
}
```

**Response 503 — at capacity, policy is REJECT**
```json
{
    "error": "at_capacity",
    "message": "string"
}
```

> **Admin mode:** to create an admin session, include `Authorization: Bearer <token>` where `<token>` is a JWT obtained from `POST /auth/login` with an admin account. Admin sessions bypass clip activation restrictions — any clip can be activated, not just the scenario's entry clip — and receive `debug_eval` messages after each clip. When the header is absent or the token is invalid, a standard student session is created with no error. See `auth.md` and `admin_and_tooling_api.md` for details.

---

### `POST /session/{session_id}/resume`

Resumes a dropped session. The client should immediately open the WebSocket
at the returned `ws_path`.

`scenario_id` and `current_clip_id` are null if the session was dropped before
a scenario was bound via `request_clip`.

**Response 200**
```json
{
    "session_id": "string",
    "state": "string",
    "scenario_id": "string | null",
    "current_clip_id": "string | null",
    "turn_count": "integer  // number of completed turns so far",
    "ws_path": "string  // e.g. '/ws/{session_id}'"
}
```

**Response 404 — session not found or expired**
```json
{
    "error": "session_not_found",
    "message": "string"
}
```

---

### `GET /session/{session_id}/queue`

Poll for queue position updates while waiting for a session slot.

**Response 200 — still queued**
```json
{
    "session_id": "string",
    "state": "queued",
    "queue_position": "integer"
}
```

**Response 200 — now active**
```json
{
    "session_id": "string",
    "state": "active",
    "queue_position": null
}
```

---

## WebSocket `/ws/{session_id}`

Connection must be established after a successful `/session/create` or
`/session/resume`. The WebSocket is the sole channel for scenario discovery,
clip negotiation, data streaming, evaluation results, and feedback delivery.

### Client → Server messages

**GetScenarios** — request the list of available scenarios
```json
{
    "type": "get_scenarios",
    "session_id": "string"
}
```

**RequestClip** — request clip metadata and video URL
```json
{
    "type": "request_clip",
    "session_id": "string",
    "scenario_id": "string",
    "clip_id": "string",
    "activate": "boolean"
}
```

`activate: true` — the client intends to play this clip. On a fresh session,
also binds the scenario and transitions the session from CONNECTING to ACTIVE.
In normal mode, must target the scenario's entry clip. In admin mode (session
created with a valid admin JWT), any clip may be activated. On a resumed session,
any clip within the already-bound scenario is valid.

`activate: false` — preload only. Pure data lookup with no state change. Valid
at any point during the session, including while a clip is playing.

**VideoFrame** — sent continuously while a clip is playing
```json
{
  "type": "video_frame",
  "session_id": "string",
  "frame_id": "integer",
  "timestamp": "float  // seconds since clip start",
  "face_landmarks": [
    { "x": "float", "y": "float", "z": "float", "visibility": "float" }
    // 478 entries
  ],
  "left_hand": [
    { "x": "float", "y": "float", "z": "float", "visibility": "float" }
    // 21 entries, empty array if not detected
  ],
  "right_hand": [
    // same as left_hand
  ]
}
```

**AudioChunk** — sent continuously while a clip is playing
```json
{
  "type": "audio_chunk",
  "session_id": "string",
  "chunk_id": "integer",
  "timestamp": "float",
  "pcm": "string  // base64-encoded raw s16le PCM bytes",
  "sample_rate": "integer  // typically 16000",
  "mfccs": [
    ["float"]
    // [n_frames][13] — pre-computed client-side via Meyda.js
  ]
}
```

**ClipEnded** — sent when a scenario clip finishes playing
```json
{
  "type": "clip_ended",
  "session_id": "string",
  "clip_id": "string  // the clip that just finished"
}
```

The client must stop sending `VideoFrame` and `AudioChunk` messages after
sending this. The App responds immediately with `clip_candidates`, then with
`clip_selected` once evaluation completes.

---

### Server → Client messages

**SessionReady** — sent when a queued session is promoted to active
```json
{
  "type": "session_ready",
  "session_id": "string"
}
```

The client should proceed to send `get_scenarios` or `request_clip` after
receiving this message.

**ScenariosListMessage** — sent in response to `get_scenarios`
```json
{
  "type": "scenarios_list",
  "session_id": "string",
  "scenarios": [
    {
      "scenario_id": "string",
      "title": "string",
      "description": "string",
      "language": "string  // ISO 639-1",
      "entry_clip_id": "string"
    }
  ]
}
```

**ClipData** — sent in response to `request_clip`
```json
{
  "type": "clip_data",
  "session_id": "string",
  "clip_id": "string",
  "scenario_id": "string",
  "video_url": "string  // browser-relative path, e.g. /scenarios/scenario_01/clip_01_intro.mp4",
  "transcript": "string",
  "notable_features": ["string"],
  "branch_conditions": [
    {
      "min_score": "float",
      "max_score": "float",
      "next_clip": "string | null"
    }
  ]
}
```

`video_url` is a browser-relative path served by the client Nginx container
from the mounted scenarios directory. The client resolves it against its own
origin — no cross-origin request is needed.

**SessionUpdate** — sent when a transcript segment arrives from the Transcription container
```json
{
  "type": "session_update",
  "session_id": "string",
  "transcript": "string  // accumulated transcript for the current clip so far",
  "queue_position": null
}
```

`queue_position` is always `null` in server-sent `SessionUpdate` messages.
Queue position is communicated via `session_ready` (on promotion) and the
`GET /session/{id}/queue` polling endpoint. Intended for development and
debugging — the client may choose not to display the transcript to students
in production.

**ClipCandidates** — sent immediately on receiving `clip_ended`, before evaluation completes
```json
{
  "type": "clip_candidates",
  "session_id": "string",
  "candidates": [
    {
      "clip_id": "string",
      "video_url": "string",
      "transcript": "string",
      "notable_features": ["string"],
      "branch_conditions": [
        {
          "min_score": "float",
          "max_score": "float",
          "next_clip": "string | null"
        }
      ]
    }
  ]
}
```

`candidates` contains one entry per distinct non-null `next_clip` value in the
finished clip's `branch_conditions`. The client should begin preloading all
candidates in parallel. `candidates` is an empty array when all branch
conditions have `next_clip: null` (terminal clip).

**ClipSelected** — sent once evaluation completes, after `ClipCandidates`
```json
{
  "type": "clip_selected",
  "session_id": "string",
  "clip_id": "string | null  // null if the scenario is terminal",
  "clip_score": "float  // escalation_score from the clip's BehaviourResult"
}
```

When `clip_id` is null the scenario is complete — the client should wait for
`FeedbackToken` and `SessionComplete` messages.

**FeedbackToken** — streamed during debrief generation
```json
{
  "type": "feedback_token",
  "session_id": "string",
  "token": "string"
}
```

**SessionComplete** — sent once when debrief generation finishes
```json
{
  "type": "session_complete",
  "session_id": "string",
  "advice": "string",
  "severity": "low | medium | high",
  "highlights": [
    "string  // e.g. 'Turn 2: voice tension spiked when student pushed back'"
  ]
}
```

**Error**
```json
{
  "type": "error",
  "session_id": "string",
  "code": "string",
  "message": "string"
}
```

Error codes:

| Code                     | Meaning                                                                             |
|--------------------------|-------------------------------------------------------------------------------------|
| `session_not_found`      | Session ID unknown or expired                                                       |
| `scenario_not_found`     | Requested scenario does not exist                                                   |
| `clip_not_found`         | Requested clip does not exist in the scenario                                       |
| `activate_not_permitted` | `activate: true` rejected — wrong clip, wrong state, or scenario mismatch on resume |
| `feedback_unavailable`   | Feedback container unreachable; session is otherwise complete                       |
| `invalid_frame`          | Malformed `video_frame` or `audio_chunk` message                                    |
| `session_expired`        | Session recovery window elapsed                                                     |

---

### Heartbeat

The App container maintains connection liveness using the WebSocket protocol's
built-in ping/pong mechanism and an application-level keepalive message during
feedback generation.

#### Protocol-level ping/pong

The server sends a WebSocket protocol-level ping frame to each connected client
every `HEARTBEAT_INTERVAL_MS` (default 30 s, configurable via the environment
variable of the same name). All major browsers respond to server pings
automatically with a pong frame — **clients must not implement their own
client-to-server heartbeat**. Adding an application-level ping from the client
would consume rate-limit budget unnecessarily and is not required for liveness
detection.

If no pong is received within `HEARTBEAT_TIMEOUT_MS` (default 70 s —
approximately two missed pongs, configurable via the environment variable of the
same name), the server treats the connection as dead: the socket is terminated
and the session is marked as dropped. The client may attempt to resume via
`POST /session/{id}/resume` within the recovery window.

The 70 s default is deliberately longer than the worst-case evaluation window
(`clip_ended` → `clip_selected`) so that a brief PAUSED state does not trigger
a false timeout. If you lower `HEARTBEAT_INTERVAL_MS` significantly, also lower
`HEARTBEAT_TIMEOUT_MS` proportionally (keep the ratio at approximately 2.3×).

#### Application-level heartbeat during feedback generation

While the App container is streaming feedback from Ollama, it sends an
application-level `heartbeat` message between `feedback_token` messages to
confirm the LLM is still active. This message is sent only if no token has been
forwarded in the last `HEARTBEAT_INTERVAL_MS`.

```json
{
  "type": "heartbeat",
  "session_id": "string",
  "status": "string  // 'feedback_generating' | 'ok'"
}
```

| `status`                | Meaning                                                      |
|-------------------------|--------------------------------------------------------------|
| `"feedback_generating"` | Ollama is still producing output; the stream has not stalled |
| `"ok"`                  | General keepalive (reserved for future use in other states)  |

The `heartbeat` message is a **transport-layer signal** and is filtered out of
the application message stream in `WebSocketTransport` before reaching
`SessionHandler` or any application callback. Client code that processes
`ServerMessage` values will never see a `heartbeat` message — only the dedicated
`onHeartbeat` callback on `TransportInterface` receives it. This means the
`heartbeat` message does not appear in `shared/types.ts`'s `ServerMessage` union.

The client can use `heartbeat` events to:
- Display a "Generating feedback…" progress indicator that confirms the server
  is still working, rather than showing a frozen spinner.
- Track the timestamp of the last received heartbeat to detect stale connections
  in the UI (exposed as `lastHeartbeat` and `heartbeatStatus` in `useSession`).