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
together with the entry clip ID. Intended for debugging and tooling.

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
            "video_url": "string",
            "transcript": "string",
            "clip_duration_seconds": "float",
            "notable_features": ["string"],
            "scoring_mode": "string",
            "de_escalation_rubric": [
                { "signal": "string", "weight": "float" }
            ],
            "escalation_rubric": [
                { "signal": "string", "weight": "float" }
            ],
            "critical_failures": ["string"],
            "score_range": { "min": "float", "max": "float" },
            "clip_learning_objectives": ["string"],
            "ideal_response": "string | null",
            "response_warnings": ["string"],
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

### `POST /scenarios`

Registers a new scenario by uploading its metadata and video files directly to
the server. The scenario becomes immediately available for sessions without
restarting the App container.

**Authentication:** `Authorization: Bearer <ADMIN_API_KEY>`. The header is
validated before any request body is read. Returns `401` if the key is absent
or does not match. Returns `501` if `ADMIN_API_KEY` is unset in the server
environment — the endpoint is permanently unavailable without an admin key
configured.

**Overwrite is not supported.** If a scenario with the same `scenario_id` already
exists, the upload is rejected with `409`. Delete the existing scenario directory
from `SCENARIOS_DIR` on the host and restart the App container before uploading
a replacement.

**Request** — `multipart/form-data`

| Part name        | Type       | Description                                                                                                                                   |
|------------------|------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| `metadata`       | text field | The full scenario metadata as a JSON string, matching the schema in `scenario_schema.md`. Must be present; order among parts does not matter. |
| `<filename>.mp4` | file part  | One binary file part per clip. Each part's **field name** must exactly match the `file` value declared for that clip in the metadata.         |

All declared clip files must be present as parts. Extra file parts (not declared
in the metadata) are ignored. The metadata `scenario_id` and all clip `file`
values are validated for path traversal characters before any file is written.

**Response 201 — scenario registered**
```json
{
    "scenario_id": "string",
    "clips_registered": "integer",
    "message": "string"
}
```

**Response 400 — validation failure**
```json
{
    "error": "validation_error",
    "message": "string  // human-readable description of what failed"
}
```

Common causes: missing required metadata fields, `entry_clip` not found in
`clips`, `branch_conditions` referencing an unknown clip, a declared clip `file`
with no corresponding upload part, or a disk write failure (read-only mount,
full disk).

**Response 409 — scenario already exists**
```json
{
    "error": "scenario_exists",
    "message": "string  // 'Scenario \"{id}\" already exists. Delete it before uploading a new version.'"
}
```

**Response 401 — missing or invalid admin key**
```json
{
    "error": "unauthorized",
    "message": "string"
}
```

**Response 501 — admin key not configured**
```json
{
    "error": "admin_unavailable",
    "message": "string"
}
```

**Example — curl**
```bash
curl -X POST http://localhost:3000/scenarios \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -F "metadata=<scenario_03/metadata.json;type=application/json" \
  -F "clip_01_intro.mp4=@scenario_03/clip_01_intro.mp4" \
  -F "clip_02_calm.mp4=@scenario_03/clip_02_calm.mp4"
```

**Durability:** metadata and video files are written to `SCENARIOS_DIR` on the
host bind mount before the in-memory index is updated. A successful `201`
response guarantees the files are on disk and will survive a container restart.
If the disk write fails partway through, any partially-written directory is
cleaned up and the in-memory index is left unchanged.

---

## Admin Sessions

Admin sessions bypass the entry-clip restriction — any clip in a scenario can
be activated, not just the entry clip. This is the mechanism for a future
teacher dashboard to start a session at an arbitrary point in the scenario graph.

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
    "confidence": "float",
    "words": [
        { "word": "string", "start": "float", "end": "float" }
    ]
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
    "confidence": "float",
    "words": [
        { "word": "string", "start": "float", "end": "float" }
    ]
}
```

`is_final` is a resolution signal, not a transcript carrier. The App container's
`ClipSession` assembles the complete transcript by concatenating the `text`
field from every received message (both partials and the final), and accumulates
all `words` entries into a flat list across all messages for the clip.
`is_final: true` signals that `ClipSession` should resolve — it does not mean
the final message carries the full accumulated text or all words.

**`words` field notes:**
- `start` and `end` are **session-level times** in seconds from clip start (reset to 0 on each `POST /transcription/reset`). The Transcription container converts from Whisper's window-relative timestamps to session-level times before emission.
- `words` is an empty array when no speech was detected in the window, or when using the stub transcription pool.
- The App container accumulates word timings across all received messages for the clip and includes the full flat list in the `AnalysisWindow` dispatched to the Evaluation container. The Evaluation container uses these to compute `silence_ratio` and `speech_pace` from actual speech boundaries rather than approximating from total clip duration.

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
the per-session PCM buffer, `window_seq` counter, and word timing state before
the next clip begins. After reset, word timing offsets restart from 0.0 so that
times in subsequent `words` arrays are always relative to the start of the new
clip.

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
transcript and word timings.

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
    "words": [
        {
            "word": "string",
            "start": "float  // seconds from clip start (session-level)",
            "end":   "float  // seconds from clip start (session-level)"
        }
    ],
    "clip_metadata": {
        "clip_id": "string",
        "scenario_id": "string",
        "video_url": "string  // included in the payload but ignored by Evaluation",
        "transcript": "string  // actor's clip transcript",
        "clip_duration_seconds": "float  // expected clip duration; used to normalise rate-based signals",
        "notable_features": ["string  // actor behaviour signals"],
        "scoring_mode": "string  // 'rubric' or 'threshold'",
        "de_escalation_rubric": [
            { "signal": "string", "weight": "float  // 0.0 to 1.0" }
        ],
        "escalation_rubric": [
            { "signal": "string", "weight": "float  // 0.0 to 1.0" }
        ],
        "critical_failures": ["string  // signal names that apply a hard score penalty"],
        "score_range": {
            "min": "float  // default -1.0",
            "max": "float  // default 1.0"
        },
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

**`words` field notes:**

`words` contains the accumulated session-level word timings for the entire clip,
assembled by the App container from all `TranscriptMessage.words` arrays received
during the clip. It is an empty array when the stub transcription pool is in use
or when no speech was detected. The Evaluation container uses word boundaries to
compute `silence_ratio` (fraction of `clip_duration_seconds` with no speech) and
`speech_pace` (syllables per second of actual speech time). When `words` is empty
both signals fall back to clip-duration-based approximations.

Fields `clip_learning_objectives`, `ideal_response`, and `response_warnings` are
not forwarded to the Evaluation container — they are Feedback-only.

**Response 200** — BehaviourResult
```json
{
    "window_id": "string",
    "session_id": "string",
    "escalation_score": "float  // -1.0 (strongly de-escalating) to 1.0 (strongly escalating), clamped to score_range",
    "dominant_emotion": "string  // e.g. 'calm', 'anxious', 'frustrated', 'neutral', 'distressed'",
    "confidence": "float  // 0.0 to 1.0; reflects proportion of rubric signals with reliable measurements",
    "signal_summary": {
        "vocal_tension": "float  // 0.0 (relaxed) to 1.0 (tense); from MFCC energy variance and audio emotion arousal",
        "speech_pace": "float  // syllables per second of actual speech; computed from word timings when available",
        "gesture_activity": "float  // variance of wrist and fingertip landmark displacement across the clip",
        "open_gesture_ratio": "float | null  // fraction of hand-detected frames with open-hand configuration; null if hands detected in fewer than 50% of frames",
        "head_nod_frequency": "float  // frequency of vertical head oscillation in Hz, from face landmark Y-coordinates",
        "facing_ratio": "float  // fraction of frames where the student is estimated to be facing the camera, based on left/right face mesh symmetry",
        "silence_ratio": "float  // fraction of clip_duration_seconds where no student speech was detected; computed from word timings when available",
        "lexical_markers": ["string  // matched Dutch empathy/validation/open-question phrases from the transcript"],
        "response_tone": "string  // 'positive', 'neutral', or 'negative'",
        "notable_signals": ["string  // e.g. 'stub_mode', 'no_hands_detected', 'critical_failure:raised_voice'"]
    }
}
```

**Signal and response notes:**

- `dominant_emotion` is derived from the audio emotion classifier (Stage A), not facial expression recognition. Values: `calm`, `anxious`, `frustrated`, `neutral`, `distressed`.
- `open_gesture_ratio` is `null` (not `0`) when hands were not detected for the majority of the clip, to distinguish a genuinely closed-hand student from one whose hands were off-camera.
- `lexical_markers` is an empty array when no Dutch de-escalation phrases were detected.
- `facing_ratio` is derived from the horizontal symmetry of left/right face mesh landmarks, not from body pose or shoulder detection. The client capture pipeline uses MediaPipe face mesh (478 face-only landmarks) and does not include body pose landmarks.
- `speech_pace` and `silence_ratio` are computed from word-level timings when `words` is non-empty. When `words` is empty (stub pool or no speech), `speech_pace` falls back to syllable count divided by `clip_duration_seconds`, and `silence_ratio` falls back to `0.0` if the transcript is non-empty or `1.0` if empty.
- `escalation_score` is the result after `score_range` clamping. The pre-clamp raw score is not returned.
- When a `critical_failure` signal is detected, the triggering signal name is appended to `notable_signals` in the form `"critical_failure:<signal_name>"` for traceability.
- `confidence` is reduced when rubric signals could not be measured (e.g. hands off-camera, empty transcript).

A non-2xx response is treated as a failed evaluation. The App falls back to a
neutral `BehaviourResult` (score 0, emotion "neutral", confidence 0, all
`signal_summary` floats at 0, `open_gesture_ratio` null, empty arrays) and the
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
    "learning_objectives": ["string"],
    "target_audience": "string | undefined  // optional; MBO level or professional context",
    "history": [
        {
            "turn_id": "integer",
            "clip": {
                "clip_id": "string",
                "scenario_id": "string",
                "transcript": "string  // actor's clip transcript",
                "notable_features": ["string"],
                "clip_learning_objectives": ["string"],
                "ideal_response": "string | null",
                "response_warnings": ["string"]
            },
            "student_response": {
                "window_id": "string",
                "session_id": "string",
                "escalation_score": "float",
                "dominant_emotion": "string",
                "confidence": "float",
                "signal_summary": {
                    "vocal_tension": "float",
                    "speech_pace": "float",
                    "gesture_activity": "float",
                    "open_gesture_ratio": "float | null",
                    "head_nod_frequency": "float",
                    "facing_ratio": "float",
                    "silence_ratio": "float",
                    "lexical_markers": ["string"],
                    "response_tone": "string",
                    "notable_signals": ["string"]
                }
            },
            "student_transcript": "string"
        }
    ]
}
```

**Notes on `clip` fields in history:**

The `clip` object sent to Feedback carries only the fields relevant to coaching: `clip_id`, `scenario_id`, `transcript`, `notable_features`, `clip_learning_objectives`, `ideal_response`, and `response_warnings`. Evaluation-only fields (`scoring_mode`, `de_escalation_rubric`, `escalation_rubric`, `critical_failures`, `score_range`, `clip_duration_seconds`) are stripped by the App container before the `FeedbackRequest` is assembled — they are machine-scoring inputs with no value to the LLM.

**Scenario-level optional fields:**

- `coaching_context` — free-text description of the professional role the student is practising. When absent the Feedback container falls back to a generic Dutch de-escalation context.
- `learning_objectives` — array of de-escalation competency labels the scenario trains. When present, the LLM anchors its advice to these objectives.
- `target_audience` — MBO level or professional context. When present, the LLM calibrates vocabulary and complexity.

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