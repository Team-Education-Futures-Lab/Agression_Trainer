# Session Lifecycle

Describes every valid state a session can be in, what triggers each transition, and what each container is responsible for during that state.

---

## State Machine

```mermaid
stateDiagram-v2
   [*] --> CONNECTING : POST /session/create (capacity available)
   [*] --> QUEUED     : POST /session/create (at capacity, policy=QUEUE)
   [*] --> REJECTED   : POST /session/create (at capacity, policy=REJECT)

   QUEUED     --> CONNECTING : slot becomes available
   QUEUED     --> REJECTED   : queue timeout exceeded

   CONNECTING --> ACTIVE  : request_clip activate=true received
   CONNECTING --> DROPPED : connection timeout (no activation within 30s)

   ACTIVE --> PAUSED    : clip ends, awaiting evaluation and branch decision
   PAUSED --> ACTIVE    : next clip starts playing
   PAUSED --> COMPLETED : null next_clip (terminal clip reached)
   ACTIVE --> DROPPED   : WebSocket disconnected unexpectedly

   DROPPED --> CONNECTING : POST /session/{id}/resume (within recovery window)
   DROPPED --> EXPIRED    : recovery window exceeded

   COMPLETED --> [*]
   REJECTED  --> [*]
   EXPIRED   --> [*]
```

---

## State Descriptions

### `CONNECTING`
Session has been created and a slot is reserved. The client has opened (or
should open) the WebSocket. The session waits for a `request_clip` message with
`activate: true` to begin. If no activation occurs within `session_timeout_s`
(default 30s), the session transitions to `DROPPED` and the slot is released.

While CONNECTING the client may freely send `get_scenarios` and
`request_clip` with `activate: false` to discover scenarios and preload clip
data without starting the session.

**App container responsibilities:**
- Reserve capacity slot
- Initialise `SessionContext` with empty `conversation_history` and null `scenario_id`
- Start connection timeout timer
- Handle `get_scenarios` — respond with `scenarios_list`
- Handle `request_clip { activate: false }` — respond with `clip_data`, no state change
- Handle `request_clip { activate: true }` — validate, bind scenario, transition to ACTIVE

---

### `QUEUED`
At-capacity session is held in a waiting room. The client opens the WebSocket
immediately and waits for a `session_ready` message. When a slot becomes
available, the session moves to CONNECTING and the App sends `session_ready`
over the WebSocket. The client can poll `GET /session/{id}/queue` for position
updates while waiting.

**App container responsibilities:**
- Maintain ordered queue
- Send `session_ready` to the client when the session is promoted
- Enforce maximum queue size — reject new sessions if queue is full

---

### `ACTIVE`
A scenario and entry clip have been bound. WebSocket is open. Frames and audio
chunks are flowing. The Coordinator routes incoming data into the current
`ClipSession`, which simultaneously forwards audio to the Transcription
container and buffers frames and MFCCs for the clip. `SessionUpdate` messages
containing the accumulated transcript are sent to the client whenever a
transcript segment arrives.

**App container responsibilities:**
- Forward `VideoFrame` messages to the Coordinator (`ClipSession` buffers them)
- Forward `AudioChunk` messages to the Coordinator (`ClipSession` forwards them to the Transcription container and buffers the MFCCs)
- Send `SessionUpdate` to the client on each received transcript segment
- Handle `request_clip { activate: false }` — respond with `clip_data`, no state change

**Transcription container responsibilities:**
- Maintain a per-connection PCM accumulation buffer for the clip
- Dispatch rolling transcription windows as audio accumulates, emitting partial `Transcript` messages
- On `POST /transcription/finalise/{session_id}`, transcribe any remaining buffered audio and emit a final `Transcript` message (`is_final: true`)

---

### `PAUSED`
A clip has finished playing. The App container:

1. Transitions ACTIVE → PAUSED immediately on receiving `clip_ended`
2. Sends `clip_candidates` immediately — full clip data for every distinct
   non-null `next_clip` in the finished clip's `branch_conditions`, allowing
   the client to begin preloading in parallel while evaluation runs
3. Finalises the transcript and dispatches the complete clip window to Evaluation
4. Awaits the `BehaviourResult`, resolves the next clip
5. Appends the completed `ConversationTurn` to session history
6. Sends `clip_selected` to the client with the resolved `clip_id` and `clip_score`
7. Calls `POST /transcription/reset/{session_id}` and `POST /evaluate/reset/{session_id}`
   to clear buffers for the next clip
8. Transitions to ACTIVE (or COMPLETED if the clip is terminal)

Note: buffer resets (step 7) happen **after** `clip_selected` is sent (step 6)
so the client receives the branching decision as quickly as possible.

This state is brief — it exists to ensure all data is committed cleanly before
the next clip begins.

**App container responsibilities:**
- Transition ACTIVE → PAUSED immediately on receiving `clip_ended`
- Derive candidates from the current clip's `branch_conditions` and send `clip_candidates`
- Call `ClipSession.flush()`, which fires `POST /transcription/finalise/{session_id}` and awaits the `is_final: true` Transcript over the WebSocket
- Once the final transcript arrives, the `ClipSession` resolves with a complete `AnalysisWindow` — all frames, MFCCs, and the full accumulated transcript
- Dispatch that `AnalysisWindow` to the Evaluation container
- Read the `escalation_score` from the returned `BehaviourResult`
- Determine `next_clip` from `ClipMetadata.branch_conditions` using that score
- Append the completed `ConversationTurn` to the session via `SessionManager.appendTurn()`
- Send `clip_selected` to the client with the resolved `clip_id` and `clip_score`
- Call `POST /transcription/reset/{session_id}` and `POST /evaluate/reset/{session_id}` to clear buffers

---

### `COMPLETED`
A terminal clip (`next_clip: null`) has been reached and all turns have been
committed. The App container compiles the full `FeedbackRequest` from
`conversation_history` and sends it to the Feedback container. Feedback is
delivered to the client over the still-open WebSocket as `FeedbackToken`
messages followed by a final `SessionComplete`.

If the Feedback container is **unreachable** (network failure), the App sends
an `error` message with code `feedback_unavailable`. A non-2xx HTTP response
from a reachable Feedback container is treated the same way.

**App container responsibilities:**
- Compile `FeedbackRequest` from `SessionContext.conversation_history`
- Send to Feedback container via streaming endpoint (`POST /feedback/generate/stream`)
- Forward SSE tokens to the client as `FeedbackToken` WebSocket messages
- Send final `SessionComplete` message when generation finishes
- On Feedback failure: send `error { code: "feedback_unavailable" }` to the client
- Release capacity slot

**Feedback container responsibilities:**
- Generate debrief from full `ConversationTurn` history
- Stream tokens back to App container via SSE

---

### `DROPPED`
WebSocket disconnected unexpectedly. The session and its `conversation_history`
are preserved in memory for `recovery_window_s` (default 30s). The capacity
slot remains reserved during this window.

If the client reconnects via `POST /session/{id}/resume` within the recovery
window, the session transitions back to `CONNECTING` and the resume response
includes the current `scenario_id`, `current_clip_id`, `turn_count`, and
`ws_path` so the client can restore state and reopen the WebSocket.

If the recovery window expires, the session transitions to `EXPIRED` and the
slot is released.

---

### `EXPIRED`
Recovery window has passed without reconnection. All session state is discarded
and the capacity slot is released. The session cannot be resumed. The client
must create a new session.

---

### `REJECTED`
Returned synchronously from `POST /session/create` when at capacity and
`CapacityPolicy` is `REJECT`. No session is created and no slot is reserved.
The client should display an appropriate message and allow the user to retry.

---

## Clip Score Calculation

The `escalation_score` used for branching at the end of each clip is the
`escalation_score` from the single `BehaviourResult` returned by the Evaluation
container for that clip.

The Evaluation container receives a complete `AnalysisWindow` covering the
student's entire response — all frames, all MFCCs, and the full transcript —
and produces one result that reflects the student's overall behaviour across the
whole clip.

```
clip_score = BehaviourResult.escalation_score
```

The first matching `branch_condition` where `min_score ≤ clip_score < max_score`
determines `next_clip`.

If the Evaluation container returns a non-2xx response or is unreachable, the
App uses a fallback score of `0` and logs a warning. The session continues
normally; the first branch condition covering score ≥ 0 is selected.

---

## Timing Constraints

| Event                                         | Constraint                                                      |
|-----------------------------------------------|-----------------------------------------------------------------|
| WebSocket must open after create              | Within `session_timeout_s` (default 30s)                        |
| `request_clip { activate: true }` must arrive | Within `session_timeout_s` of WebSocket open                    |
| Reconnect after drop                          | Within `recovery_window_s` (default 30s)                        |
| Queue position update interval                | Client-side polling of `GET /session/{id}/queue`                |
| `clip_candidates` sent                        | Immediately on `clip_ended`, before evaluation is dispatched    |
| Flush on clip end                             | Immediately after `clip_candidates` is sent                     |
| `clip_selected` sent                          | After evaluation completes; before buffer resets                |
| ClipSession resolve timeout                   | 5s — if final transcript not received, clip proceeds without it |
| `video_frame` rate limit                      | 60 frames per second — excess frames dropped silently           |
| `audio_chunk` rate limit                      | 1 chunk per second — excess chunks dropped silently             |