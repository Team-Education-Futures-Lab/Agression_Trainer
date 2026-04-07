# API Contract

Defines the exact wire format for all communication between the browser client and the App container. All HTTP bodies are JSON unless stated otherwise. All WebSocket messages are JSON frames unless stated otherwise.

This document is the source of truth for the **client-facing** interface. If a TypeScript type definition and this document conflict, this document takes precedence.

> **Internal and tooling APIs** — the inter-container APIs (App→Transcription, App→Evaluation, App→Feedback), the health endpoint, admin session creation, and debugging endpoints are documented separately in `admin_and_tooling_api.md`.

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

> **Admin mode:** pass `Authorization: Bearer <ADMIN_API_KEY>` to create an admin session. Admin sessions bypass clip activation restrictions — any clip can be activated, not just the scenario's entry clip. Admin sessions also receive `debug_eval` messages after each clip (see [Debug messages](#debug-messages-admin-sessions-only)). See `admin_and_tooling_api.md` for details.

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
clip negotiation, data streaming, evaluation results, feedback delivery, and
(for admin sessions) evaluation debug data.

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
created with `ADMIN_API_KEY`), any clip may be activated. On a resumed session,
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
`clip_selected` once evaluation completes. For admin sessions, `debug_eval`
follows `clip_selected`.

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

For admin sessions, `debug_eval` is sent immediately after `clip_selected`.

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

## Debug messages (admin sessions only)

> **Visibility:** `debug_eval` is **never sent to non-admin sessions.** The App container does not request debug data from the Evaluation container for non-admin sessions, and non-admin clients will never receive this message type regardless of any client-side request or configuration. There is no opt-in mechanism for non-admin sessions.

**DebugEval** — sent immediately after `clip_selected`, for admin sessions only

Carries the full evaluation result for the completed clip, together with
implementation-specific intermediate data from the Evaluation container's
analysis pipeline and App-level capture statistics.

```json
{
    "type": "debug_eval",
    "session_id": "string",
    "window_id": "string  // '{session_id}:{clip_sequence}'",

    "capture": {
        "frame_count": "integer  // VideoFrame messages received for this clip",
        "audio_chunk_count": "integer  // AudioChunk messages received for this clip",
        "word_timing_count": "integer  // word timing entries forwarded to Evaluation",
        "eval_fallback": "boolean  // true if the neutral fallback score was used (Evaluation returned non-2xx or was unreachable)",
        "eval_latency_ms": "integer  // round-trip time for the POST /evaluate/analyse call, in milliseconds"
    },

    "transcript": {
        "final_text": "string  // complete accumulated transcript for the clip",
        "words": [
            {
                "word": "string",
                "start": "float  // seconds from clip start",
                "end": "float  // seconds from clip start"
            }
        ]
    },

    "result": {
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

    "analyser_id": "string  // e.g. 'stub' or 'production'; identifies the BehaviourAnalyser implementation",
    "stages": "object | null  // implementation-specific intermediate data; shape is determined by analyser_id"
}
```

### `stages` field

`stages` contains intermediate data from the Evaluation container's analysis
pipeline. Its shape varies by `analyser_id`. Clients must use `analyser_id` to
determine how to interpret `stages`. If a client encounters an `analyser_id` it
does not recognise, it must treat `stages` as an opaque object — it may log or
display it raw but must not attempt to parse or render it against a known schema.
New implementation IDs may be introduced in future without a protocol version bump.

The `stages` field may be large. When the production analyser is active it can
include per-word timing arrays, scored signal sets, and multi-stage floating-point
outputs. Clients should not assume the field is small or that it can be rendered
inline without truncation.

#### `stages` for `analyser_id: "stub"`

The stub analyser has no meaningful intermediate stages. It returns a minimal
object confirming that the debug path itself is functioning.

```json
{
    "note": "string  // always 'stub analyser — no intermediate stage data available'"
}
```

#### `stages` for `analyser_id: "production"`

Reflects the four-stage pipeline described in `architecture.md`. All four stage
keys are always present; individual fields within a stage may be absent if that
stage could not run (e.g. empty MFCC input, no speech detected).

```json
{
    "stage_a_audio_emotion": {
        "audio_emotion_label": "string  // raw label from the audio emotion classifier",
        "arousal": "float  // 0.0 (low) to 1.0 (high)",
        "valence": "float  // -1.0 (negative) to 1.0 (positive)",
        "energy_var_norm": "float  // normalised MFCC energy variance across the clip; input to vocal_tension alongside arousal"
    },
    "stage_b_landmark_features": {
        "hands_detected_ratio": "float  // fraction of frames where at least one hand landmark array was non-empty",
        "gesture_activity": "float  // variance of wrist and fingertip displacement vectors",
        "facing_frame_count": "integer  // number of frames where the face was estimated to be forward-facing",
        "total_frame_count": "integer  // total frames processed in Stage B",
        "nod_fft_peak_hz": "float  // frequency of the dominant peak in the head Y-coordinate oscillation spectrum"
    },
    "stage_c_transcript_features": {
        "speech_duration_s": "float  // cumulative speech duration derived from word timing boundaries",
        "silence_duration_s": "float  // clip_duration_seconds minus speech_duration_s",
        "word_count": "integer",
        "syllable_count": "integer  // estimated syllable count used for speech_pace",
        "sentiment_raw_label": "string  // raw label from the sentiment classifier, e.g. 'POSITIVE', 'NEGATIVE', 'NEUTRAL'",
        "sentiment_raw_score": "float  // classifier confidence for sentiment_raw_label"
    },
    "scorer": {
        "detected_signals": ["string  // signal names from the rubric vocabulary that were detected as active for this clip"],
        "de_score": "float  // weighted sum of detected de-escalation signals before normalisation",
        "esc_score": "float  // weighted sum of detected escalation signals before normalisation",
        "de_weight_total": "float  // sum of all de_escalation_rubric weights for this clip",
        "esc_weight_total": "float  // sum of all escalation_rubric weights for this clip",
        "raw_score_pre_clamp": "float  // normalised escalation_score before score_range clamping is applied"
    }
}
```