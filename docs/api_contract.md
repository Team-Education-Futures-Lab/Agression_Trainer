# API Contract

Defines the exact wire format for all communication between containers. All HTTP bodies are JSON unless stated otherwise. All WebSocket messages are JSON frames unless stated otherwise.

This document is the source of truth for inter-container communication. If a Python interface definition and this document conflict, this document takes precedence for anything crossing a container boundary.

---

## App Container — Client-facing

### `POST /session/create`

**Request**
```json
{
  "user_id": "string",
  "scenario_id": "string",
  "language": "string  // ISO 639-1, e.g. 'nl'"
}
```

**Response 200 — session created**
```json
{
  "session_id": "string  // UUID",
  "state": "active",
  "scenario_id": "string",
  "language": "string"
}
```

**Response 200 — session queued**
```json
{
  "session_id": "string",
  "state": "queued",
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

---

### `POST /session/{session_id}/resume`

**Response 200**
```json
{
  "session_id": "string",
  "state": "string",
  "scenario_id": "string",
  "current_clip_id": "string",
  "turn_count": "integer  // number of completed turns so far"
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

### `POST /session/{session_id}/end`

No request body required. Handles abnormal termination only — in the normal clip flow, sessions complete automatically when a terminal clip is reached via `ClipEnded`.

**Response 200**
```json
{
  "session_id": "string",
  "state": "completed",
  "message": "string"
}
```

---

### `GET /session/{session_id}/queue`

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

### `GET /health`

Called by monitoring tools and the compose healthcheck. Queries all configured
evaluation, transcription, and feedback instances in parallel and reports per-instance
reachability.

**Status levels**

| `status`   | Meaning                                                                                                                                                          |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ok`       | All instances and feedback reachable.                                                                                                                            |
| `degraded` | Some (but not all) evaluation or transcription instances unreachable, or feedback down. Sessions may be served at reduced capacity; debriefs may be unavailable. |
| `critical` | All evaluation or all transcription instances unreachable. Sessions cannot be meaningfully processed.                                                            |

**Response 200 — ok or degraded**
```json
{
  "status": "ok | degraded",
  "services": {
    "evaluation": {
      "status": "ok | degraded | critical",
      "instances": {
        "http://eval1:8001": "ok",
        "http://eval2:8001": "unreachable"
      }
    },
    "transcription": {
      "status": "ok | degraded | critical",
      "instances": {
        "http://transcription1:8003": "ok"
      }
    },
    "feedback": {
      "status": "ok | unreachable"
    }
  }
}
```

**Response 503 — critical (all evaluation or transcription instances down)**
```json
{
  "status": "critical",
  "services": {
    "evaluation": {
      "status": "critical",
      "instances": {
        "http://eval1:8001": "unreachable"
      }
    },
    "transcription": {
      "status": "ok",
      "instances": {
        "http://transcription1:8003": "ok"
      }
    },
    "feedback": {
      "status": "ok | unreachable"
    }
  }
}
```

---

### `WebSocket /ws/{session_id}`

Connection must be established after a successful `/session/create` or `/session/resume`.

#### Client → Server messages

**VideoFrame**
```json
{
  "type": "video_frame",
  "session_id": "string",
  "frame_id": "integer",
  "timestamp": "float  // seconds since session start",
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

**AudioChunk**
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

The client must stop sending `VideoFrame` and `AudioChunk` messages after sending this and wait for a `ClipReady` or `SessionComplete` response.

#### Server → Client messages

**SessionUpdate** — sent when a finalised transcript segment arrives from the Transcription container
```json
{
  "type": "session_update",
  "session_id": "string",
  "transcript": "string  // accumulated transcript for the current clip so far",
  "queue_position": "integer | null"
}
```

This message is intended for development and debugging. The client may choose not to display the transcript to students in production.

**ClipReady** — sent in response to a `ClipEnded` message
```json
{
  "type": "clip_ready",
  "session_id": "string",
  "next_clip_id": "string | null  // null when the scenario is complete",
  "clip_score": "float  // escalation_score from the clip's BehaviourResult"
}
```

When `next_clip_id` is `null` the scenario is complete — the client should wait for `FeedbackToken` and `SessionComplete` messages.

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
  "code": "string  // e.g. 'session_expired', 'invalid_frame'",
  "message": "string"
}
```

---

## App → Transcription Container

The App container maintains one persistent WebSocket connection per session to the Transcription container for continuous audio streaming. The App container pins each session to a consistent Transcription instance (via session ID hash) so the per-session VAD buffer stays coherent.

### Authentication

All requests from the App container include a shared secret in the `Authorization` header:

```
Authorization: Bearer <INTERNAL_API_KEY>
```

The Transcription container validates this on every request and returns `401` if the header is absent or the key does not match.

### `WebSocket /ws/{session_id}`

Opened by the App container once per session. Same `AudioChunk` message format as the client-facing WebSocket.

#### Transcription → App messages

**Transcript — partial**
```json
{
  "type": "transcript",
  "session_id": "string",
  "text": "string",
  "window_seq": "integer",
  "is_final": false,
  "confidence": "float"
}
```

**Transcript — final**
```json
{
  "type": "transcript",
  "session_id": "string",
  "text": "string",
  "window_seq": "integer",
  "is_final": true,
  "confidence": "float"
}
```

---

### `POST /transcription/finalise/{session_id}`

No request body. Called by the App container just before clip evaluation is dispatched, asking the Transcription container to flush any in-flight audio and emit a final `Transcript` message.

**Response 200**
```json
{ "session_id": "string", "status": "finalised" }
```

---

### `POST /transcription/reset/{session_id}`

No request body. Called by the App container at the end of each clip to clear the per-session VAD buffer before the next clip begins.

**Response 200**
```json
{ "session_id": "string", "status": "reset" }
```

---

### `GET /transcription/health`

**Response 200**
```json
{
  "status": "ok",
  "whisper_workers": {
    "total": "integer",
    "available": "integer"
  },
  "device": "cpu | cuda"
}
```

---

## App → Evaluation Container

The App container calls the Evaluation container directly using the URL(s) in `EVALUATION_URL`. There is no proxy between them. One `AnalysisWindow` is dispatched per clip, covering the student's complete response with the full accumulated transcript.

### Authentication

Same shared secret scheme as Transcription — all requests carry `Authorization: Bearer <INTERNAL_API_KEY>`. The Evaluation container returns `401` if the header is absent or the key does not match.

### `POST /evaluate/analyse`

**Request** — AnalysisWindow
```json
{
  "window_id": "string  // '{session_id}:{clip_sequence}'",
  "session_id": "string",
  "frames": [ "VideoFrame  // same shape as WebSocket VideoFrame message" ],
  "mfccs": [["float"]],
  "transcript": "string  // complete transcript of the student's response for this clip",
  "clip_metadata": {
    "clip_id": "string",
    "scenario_id": "string",
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
}
```

**Response 200** — BehaviourResult
```json
{
  "window_id": "string",
  "session_id": "string",
  "escalation_score": "float  // -1.0 to 1.0",
  "dominant_emotion": "string  // e.g. 'angry', 'calm', 'fearful'",
  "confidence": "float  // 0.0 to 1.0",
  "signal_summary": {
    "voice_tension": "float",
    "speech_pace": "float  // syllables/sec",
    "hand_velocity": "float  // avg landmark movement per frame",
    "gaze_stability": "float  // 0=erratic, 1=steady",
    "open_palm_ratio": "float",
    "notable_signals": ["string"]
  }
}
```

---

### `POST /evaluate/reset/{session_id}`

No request body. Called by the App container at the end of each clip.

**Response 200**
```json
{ "session_id": "string", "status": "reset" }
```

---

### `GET /evaluate/health`

**Response 200**
```json
{
  "status": "ok",
  "device": "cpu | cuda"
}
```

---

## App → Feedback Container

The App container calls the Feedback container directly using the URL in `FEEDBACK_URL`. There is no proxy between them.

### Authentication

Same shared secret scheme — all requests carry `Authorization: Bearer <INTERNAL_API_KEY>`. The Feedback container returns `401` if the header is absent or the key does not match.

### `POST /feedback/generate`

**Request** — FeedbackRequest
```json
{
  "session_id": "string",
  "scenario_id": "string",
  "language": "string",
  "history": [
    {
      "turn_id": "integer",
      "clip": "ClipMetadata  // same shape as in AnalysisWindow",
      "student_response": "BehaviourResult  // same shape as /evaluate/analyse response",
      "student_transcript": "string"
    }
  ]
}
```

**Response 200** — Feedback
```json
{
  "session_id": "string",
  "advice": "string",
  "severity": "low | medium | high",
  "highlights": ["string"]
}
```

---

### `POST /feedback/generate/stream`

Same request body as `/feedback/generate`.

**Response** — `text/event-stream` (SSE)

Token events during generation:
```
data: {"type": "token", "token": "string"}\n\n
```

Final event once generation completes:
```
data: {"type": "complete", "feedback": { ...Feedback object... }}\n\n
```

---

### `GET /feedback/health`

**Response 200**
```json
{
  "status": "ok",
  "ollama_reachable": "boolean",
  "model": "string  // e.g. 'llama3.2'"
}
```