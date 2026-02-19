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

No request body required.

**Response 200**
```json
{
  "session_id": "string",
  "state": "completed",
  "message": "Feedback generation started. Deliver via WebSocket."
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

#### Server → Client messages

**SessionUpdate** — sent after every analysis window
```json
{
  "type": "session_update",
  "session_id": "string",
  "window_id": "string  // '{session_id}:{sequence}'",
  "escalation_score": "float  // -1.0 to 1.0",
  "queue_position": "integer | null"
}
```

**Feedback** — sent once at session end
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

**FeedbackToken** — sent during streaming generation, before final Feedback
```json
{
  "type": "feedback_token",
  "session_id": "string",
  "token": "string"
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

## Proxy → Evaluation Container

### `POST /evaluate/analyse`

**Request** — AnalysisWindow
```json
{
  "window_id": "string  // '{session_id}:{sequence}'",
  "session_id": "string",
  "frames": [ "VideoFrame  // same shape as WebSocket VideoFrame message" ],
  "mfccs": [["float"]],
  "transcript": "string",
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

No request body.

**Response 200**
```json
{ "session_id": "string", "status": "reset" }
```

---

### `WebSocket /ws/{session_id}`

Proxied directly from the App container. Same `AudioChunk` message format as the client-facing WebSocket.

#### Server → App messages (over this WebSocket)

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

### `GET /evaluate/health`

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

## Proxy → Feedback Container

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

---

## Proxy — Health Aggregation

### `GET /health`

**Response 200 — all healthy**
```json
{
  "status": "ok",
  "services": {
    "evaluation": "ok",
    "feedback": "ok"
  }
}
```

**Response 503 — any service degraded**
```json
{
  "status": "degraded",
  "services": {
    "evaluation": "ok",
    "feedback": "unreachable"
  }
}
```
