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

## Admin Sessions

Admin sessions bypass the entry-clip restriction — any clip in a scenario can
be activated, not just the entry clip. This is the mechanism for a future
teacher dashboard to start a session at an arbitrary point in the scenario graph.
Admin sessions also receive `debug_eval` WebSocket messages after each clip
(see [Debug messages (admin sessions only)](api_contract.md#debug-messages-admin-sessions-only) in `api_contract.md`).

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
is already threaded through to clip activation validation and debug data requests.

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

The App container adds the header `X-Debug: true` to this request when and only
when the session is an admin session (`is_admin === true`). When this header is
present the Evaluation container includes a `debug` field in its response (see
below). The header is never sent for non-admin sessions — the Evaluation
container bears no overhead of assembling debug output for sessions that will not
use it.

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

**Response 200** — BehaviourResult (with optional debug field)

When the request did not include `X-Debug: true`:
```json
{
    "window_id": "string",
    "session_id": "string",
    "escalation_score": "float",
    "dominant_emotion": "string",
    "confidence": "float",
    "signal_summary": { "...see BehaviourResult schema in api_contract.md..." }
}
```

When the request included `X-Debug: true`, an additional top-level `debug` field
is present:
```json
{
    "window_id": "string",
    "session_id": "string",
    "escalation_score": "float",
    "dominant_emotion": "string",
    "confidence": "float",
    "signal_summary": { "...same as above..." },
    "debug": {
        "analyser_id": "string  // e.g. 'stub' or 'production'",
        "stages": "object | null  // implementation-specific intermediate data; shape determined by analyser_id"
    }
}
```

The App container reads `debug` from the response and includes it verbatim in
the `debug_eval` WebSocket message sent to the admin client. The `analyser_id`
and `stages` schemas are documented in `api_contract.md` under
[Debug messages (admin sessions only)](api_contract.md#debug-messages-admin-sessions-only).

**Signal and response notes:**

- `dominant_emotion` is derived from the audio emotion classifier (Stage A), not facial expression recognition. Values: `calm`, `anxious`, `frustrated`, `neutral`, `distressed`.
- `open_gesture_ratio` is `null` (not `0`) when hands were not detected for the majority of the clip, to distinguish a genuinely closed-hand student from one whose hands were off-camera.
- `lexical_markers` is an empty array when no Dutch de-escalation phrases were detected.
- `facing_ratio` is derived from the horizontal symmetry of left/right face mesh landmarks, not from body pose or shoulder detection. The client capture pipeline uses MediaPipe face mesh (478 face-only landmarks) and does not include body pose landmarks.
- `speech_pace` and `silence_ratio` are computed from word-level timings when `words` is non-empty. When `words` is empty (stub pool or no speech), `speech_pace` falls back to syllable count divided by `clip_duration_seconds`, and `silence_ratio` falls back to `0.0` if the transcript is non-empty or `1.0` if empty.
- `escalation_score` is the result after `score_range` clamping. The pre-clamp raw score is not returned in the normal response; it is available in `debug.stages.scorer.raw_score_pre_clamp` when debug output is requested.
- When a `critical_failure` signal is detected, the triggering signal name is appended to `notable_signals` in the form `"critical_failure:<signal_name>"` for traceability.
- `confidence` is reduced when rubric signals could not be measured (e.g. hands off-camera, empty transcript).

A non-2xx response is treated as a failed evaluation. The App falls back to a
neutral `BehaviourResult` (score 0, emotion "neutral", confidence 0, all
`signal_summary` floats at 0, `open_gesture_ratio` null, empty arrays) and the
session continues normally — the first branch condition at score ≥ 0 is selected.
When an eval fallback occurs for an admin session, the `debug_eval` message is
still sent with `capture.eval_fallback: true` and `result` set to the neutral
fallback values; `stages` is `null`.

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

## Evaluation Container — Debug Output

Debug output from the Evaluation container is an optional enrichment of the
normal `POST /evaluate/analyse` response. It is not a separate endpoint — the
App container requests it by including `X-Debug: true` in the request header,
and the Evaluation container includes a `debug` field in the response body when
that header is present.

### Requesting debug output

The App container adds `X-Debug: true` to `POST /evaluate/analyse` when and
only when `session.is_admin === true`. For all other sessions the header is
absent and the Evaluation container returns the standard `BehaviourResult` with
no `debug` field.

This design keeps the evaluation response format stable for normal sessions and
imposes no overhead (no intermediate data assembly, no extra serialisation) on
the common path.

### Debug response field

When `X-Debug: true` is present, the response includes:

```json
{
    "debug": {
        "analyser_id": "string",
        "stages": "object | null"
    }
}
```

`analyser_id` identifies which `BehaviourAnalyserInterface` implementation
produced the response. The App container forwards this value verbatim to the
admin client in the `debug_eval` WebSocket message. The known values and their
corresponding `stages` schemas are documented in `api_contract.md`.

The `stages` field may be large — the production analyser can include scored
signal sets, per-word timing arrays, and multi-stage floating-point outputs.
The Evaluation container does not truncate or compress `stages`; clients are
responsible for handling potentially large payloads.

### `GET /evaluate/debug/config`

Returns the active threshold configuration and lexical phrase lists used by the
Evaluation container. Protected by `INTERNAL_API_KEY`. Intended for operators
to verify that a deployed container is running with the expected configuration
without reading the filesystem.

```
Authorization: Bearer <INTERNAL_API_KEY>
```

**Response 200**
```json
{
    "analyser_id": "string  // e.g. 'production' or 'stub'",
    "device": "cpu | cuda",
    "signal_thresholds": {
        "vocal_tension_high": "float  // vocal_tension value above which 'raised_voice' is detected",
        "vocal_tension_low": "float  // vocal_tension value below which 'calm_voice' is detected",
        "speech_pace_high": "float  // syllables/sec above which 'fast_speech' is detected",
        "speech_pace_low": "float  // syllables/sec below which 'measured_pace' is detected",
        "silence_ratio_high": "float  // silence_ratio above which 'long_silence' is detected",
        "silence_ratio_mid_min": "float  // silence_ratio lower bound for 'appropriate_silence'",
        "silence_ratio_mid_max": "float  // silence_ratio upper bound for 'appropriate_silence'",
        "head_nod_frequency_min": "float  // Hz above which 'active_listening' is detected",
        "facing_ratio_low": "float  // facing_ratio below which 'turning_away' is detected",
        "facing_ratio_high": "float  // facing_ratio above which 'open_posture' is detected",
        "open_gesture_ratio_low": "float  // open_gesture_ratio below which 'closed_gesture' is detected",
        "open_gesture_ratio_high": "float  // open_gesture_ratio above which 'open_gesture' is detected",
        "hands_detected_min_ratio": "float  // minimum fraction of frames with hands detected for open_gesture_ratio to be computed (not null)"
    },
    "lexical_marker_phrases": {
        "empathy_acknowledgements": ["string  // Dutch phrases matched for 'empathy_phrase' signal"],
        "validation_phrases": ["string  // Dutch phrases matched for 'validation' signal"],
        "open_question_patterns": ["string  // Dutch patterns matched for 'open_question' signal"]
    }
}
```

**Response 401** — missing or invalid `INTERNAL_API_KEY`.

> **Note:** This endpoint reflects the configuration of the single container instance that handles the request. In a multi-instance deployment (`--scale evaluation=N`), query each instance separately if you need to confirm all instances are running identical configuration.

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