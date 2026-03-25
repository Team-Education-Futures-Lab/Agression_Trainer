# Admin, Tooling, and Internal API

Documents the App container's operator-facing HTTP endpoints, admin session mechanics, and all inter-container API calls. None of the endpoints in this document are part of the normal student-facing session flow — they exist for monitoring, debugging, abnormal termination, and internal container communication.

> **Client-facing API** — the session lifecycle, WebSocket messages, and normal clip flow are documented in `api_contract.md`.

---

## App Container — Operator and Tooling Endpoints

### `GET /health`

Called by monitoring tools and the compose healthcheck. Queries all configured
evaluation, transcription, and feedback instances in parallel and reports
per-instance reachability.

> **Performance note:** Each backend health check is an outbound `fetch()` call with a 5-second timeout. In a degraded network this endpoint may take up to 5 seconds to respond. Do not use it as a low-latency liveness probe — rely on the compose healthcheck on the individual AI service containers for that purpose.

**Status levels**

| `status`   | Meaning                                                                                                                                                          |
|------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ok`       | All instances and feedback reachable.                                                                                                                            |
| `degraded` | Some (but not all) evaluation or transcription instances unreachable, or feedback down. Sessions may be served at reduced capacity; debriefs may be unavailable. |
| `critical` | All evaluation or all transcription instances unreachable. Sessions cannot be meaningfully processed.                                                            |

No authentication required.

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

**Response 503 — critical**

Same shape as above with `"status": "critical"`.

> **Note:** The `instances` object includes the full internal URL of each backend service. These URLs are only meaningful within the Docker compose network and are included to aid debugging. Do not expose `GET /health` on a public-facing port in production deployments.

---

### `POST /session/{session_id}/end`

Handles **abnormal termination only**. In the normal clip flow, sessions
complete automatically when a terminal clip is reached via `clip_ended` over
the WebSocket.

Calling this endpoint flushes any in-flight coordinator state and marks the
session as completed. It does **not** stream feedback to the client; the
response is a plain JSON acknowledgement. Use the WebSocket `clip_ended` flow
for normal session completion with feedback delivery.

No request body. No authentication required.

**Response 200**
```json
{
    "session_id": "string",
    "state": "completed",
    "message": "string"
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

### `GET /scenarios/{scenario_id}/clips`

Returns all clips defined in a scenario, in metadata.json definition order,
together with the entry clip ID. Intended for debugging and tooling — useful
when you need to know all available clip IDs without reading the raw metadata
file.

No authentication required.

**Response 200**
```json
{
    "scenario_id": "string",
    "entry_clip_id": "string",
    "clips": [
        {
            "clip_id": "string",
            "scenario_id": "string",
            "video_url": "string  // browser-relative path",
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

**Response 404 — scenario not found**
```json
{
    "error": "scenario_not_found",
    "message": "string"
}
```

---

## Admin Sessions

Admin sessions bypass the entry-clip restriction — any clip in a scenario can
be activated, not just the entry clip. This is the mechanism for a future
teacher dashboard to start a session at an arbitrary point in the scenario graph
(e.g. for demonstration or assessment purposes).

### Creating an admin session

Include `Authorization: Bearer <ADMIN_API_KEY>` in the `POST /session/create`
request. If `ADMIN_API_KEY` is unset in the server environment, this header is
ignored and admin mode is permanently unavailable.

```http
POST /session/create
Authorization: Bearer <ADMIN_API_KEY>
Content-Type: application/json

{
    "user_id": "teacher-01",
    "language": "nl"
}
```

The response is identical to a normal session create. The `is_admin` flag is
stored internally on the `SessionContext` and is not exposed in any response.

### Extension point

When a teacher dashboard is added, replace the single `ADMIN_API_KEY` env var
check at session creation with a per-token lookup against a teacher credential
store. Nothing downstream changes — the `is_admin` flag on the session context
is already threaded through to clip activation validation.

---

## App → Transcription Container

The App container maintains one persistent WebSocket connection per session to
the Transcription container for continuous audio streaming. The App pins each
session to a consistent Transcription instance (via session ID hash) so the
per-session VAD buffer stays coherent.

### Authentication

All requests from the App container carry a shared secret:

```
Authorization: Bearer <INTERNAL_API_KEY>
```

The Transcription container validates this on every request and returns `401`
if the header is absent or the key does not match.

### `WebSocket /ws/{session_id}`

Opened by the App container once per clip. Same `AudioChunk` message format as
the client-facing WebSocket. The `session_id` field in forwarded `AudioChunk`
messages is always overwritten by the App container with the authoritative
URL-path session ID before forwarding — the client-supplied value in the message
body is never trusted for routing.

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

`is_final` is a resolution signal, not a transcript carrier. The App container's
`ClipSession` assembles the complete transcript by concatenating the `text`
field from every received message (both partials and the final). `is_final: true`
signals that `ClipSession` should resolve — it does not mean the final message
carries the full accumulated text.

---

### `POST /transcription/finalise/{session_id}`

No request body. Called by the App container immediately before clip evaluation
is dispatched. Asks the Transcription container to flush any in-flight audio
and emit a final `Transcript` message (`is_final: true`).

**Response 200**
```json
{ "session_id": "string", "status": "finalised" }
```

**Response 404** — session not found (WebSocket was never opened or has already
closed). The App container treats this as non-fatal and proceeds with whatever
transcript has accumulated.

---

### `POST /transcription/reset/{session_id}`

No request body. Called by the App container after each clip transition to clear
the per-session PCM buffer and `window_seq` counter before the next clip begins.

**Response 200**
```json
{ "session_id": "string", "status": "reset" }
```

---

### `GET /transcription/health`

No authentication required.

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

The App container calls the Evaluation container directly using the URL(s) in
`EVALUATION_URL`. There is no proxy. One `AnalysisWindow` is dispatched per
clip, covering the student's complete response with the full accumulated
transcript.

### Authentication

Same shared secret scheme as Transcription — all requests carry
`Authorization: Bearer <INTERNAL_API_KEY>`. The Evaluation container returns
`401` if the header is absent or the key does not match.

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
        "video_url": "string  // included in the payload but ignored by Evaluation",
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

A non-2xx response is treated as a failed evaluation. The App falls back to a
neutral `BehaviourResult` (score 0, emotion "neutral", confidence 0) and the
session continues normally — the first branch condition at score ≥ 0 is selected.

---

### `POST /evaluate/reset/{session_id}`

No request body. Called by the App container after each clip. The Evaluation
container is stateless — this is a no-op that exists for API symmetry with the
Transcription container. Returns 200 unconditionally.

**Response 200**
```json
{ "session_id": "string", "status": "reset" }
```

---

### `GET /evaluate/health`

No authentication required.

**Response 200**
```json
{
    "status": "ok",
    "device": "cpu | cuda"
}
```

---

## App → Feedback Container

The App container calls the Feedback container directly using the URL in
`FEEDBACK_URL`. There is no proxy.

### Authentication

Same shared secret scheme — all requests carry `Authorization: Bearer <INTERNAL_API_KEY>`.
The Feedback container returns `401` if the header is absent or the key does not match.

### `POST /feedback/generate`

Synchronous generation — waits for the full response before returning. Used for
testing and tooling. For the normal production path use
`POST /feedback/generate/stream`.

**Request** — FeedbackRequest
```json
{
    "session_id": "string",
    "scenario_id": "string",
    "language": "string  // ISO 639-1, e.g. 'nl'",
    "coaching_context": "string | undefined  // optional; scenario-specific LLM prompt framing",
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

`coaching_context` is an optional free-text field describing the professional
role the student is practising. When absent the Feedback container falls back
to a generic Dutch de-escalation context. This field is populated from the
scenario's `coaching_context` metadata field by the App container.

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

Same request body as `/feedback/generate`. This is the endpoint called by the
App container during normal session completion. The App reads the SSE stream and
forwards tokens to the client as `feedback_token` WebSocket messages.

**Response** — `text/event-stream` (SSE)

Token events during generation:
```
data: {"type": "token", "token": "string"}\n\n
```

Final event once generation completes:
```
data: {"type": "complete", "feedback": { ...Feedback object... }}\n\n
```

Error event if generation fails:
```
data: {"type": "error", "message": "string"}\n\n
```

---

### `GET /feedback/health`

No authentication required.

**Response 200**
```json
{
    "status": "ok",
    "ollama_reachable": "boolean",
    "model": "string  // e.g. 'llama3.2'"
}
```

`ollama_reachable` is `false` when Ollama is unreachable but the response is
still `200` — the container is up, just degraded. The App container checks this
field and reports `feedback: { status: "unreachable" }` in its aggregated health
response.