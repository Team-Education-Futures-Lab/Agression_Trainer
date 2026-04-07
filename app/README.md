# App Container

The App container is the single entry point for all clients. It manages session lifecycle, accumulates webcam and audio data across each clip, coordinates clip transitions, and delivers feedback at session end.

No ML models are loaded here — all processing is delegated to the Evaluation, Transcription, and Feedback containers.

---

## Responsibilities

- **Session management** — capacity enforcement, queue management, state transitions, and recovery from dropped connections
- **Data accumulation** — buffers `VideoFrame`, `AudioChunk`, and live transcript segments for the full duration of each clip, then dispatches a single complete `AnalysisWindow` to the Evaluation container when the clip ends
- **Transcription streaming** — forwards audio to the Transcription container continuously during a clip and accumulates partial/final transcript segments, sending `SessionUpdate` messages to the client on each finalised segment for debugging
- **Clip transitions** — on `ClipEnded`, finalizes the transcript, dispatches the clip window, resolves the next clip from branch conditions, commits a `ConversationTurn`, resets both the Evaluation and Transcription buffers, and notifies the client via `ClipSelected`
- **Feedback delivery** — at session end, compiles the full `ConversationTurn` history into a `FeedbackRequest` and streams the LLM debrief back to the client token by token
- **Debug data path** — for admin sessions, attaches `X-Debug: true` to each evaluation request and forwards the resulting intermediate stage data to the admin client as a `debug_eval` WebSocket message immediately after `clip_selected`

---

## Architecture

### Classes

**`SessionManager`** — owns session state. Tracks every session from creation through completion or expiry, enforces capacity limits, manages the waiting queue, and preserves session state across dropped connections within the recovery window. Admin sessions (created with a valid `ADMIN_API_KEY`) bypass entry-clip restrictions and receive debug data after each clip.

**`Coordinator`** — coordinates the data pipeline for each active session. Creates one `ClipSession` per clip, routes incoming frames and audio into it, calls `flush()` on `ClipEnded`, awaits the resolved `AnalysisWindow`, and dispatches it to the Evaluation container. Adds `X-Debug: true` to the evaluation request for admin sessions and stores the returned debug payload for the `ClipController` to forward. Threads the session language through to every `ClipSession` so the Transcription container uses the correct Whisper language for each session.

**`ClipSession`** — owns the full lifecycle of one clip's relationship with the Transcription service. Opens a WebSocket to the Transcription container on construction (with the session language as a query parameter), forwards audio chunks, accumulates frames, MFCCs, and transcript segments, and resolves as a thenable with a complete `AnalysisWindow` once the Transcription service emits a final transcript segment. One `ClipSession` is created per clip.

**`ClipController`** — owns the clip transition sequence. On receiving a `ClipEnded` message it flushes the coordinator (finalising transcript and dispatching to Evaluation), reads the clip score from the single `BehaviourResult`, resolves the next clip from branch conditions, appends a `ConversationTurn` to session history, resets both buffers, sends `clip_selected`, and (for admin sessions) immediately follows with a `debug_eval` message. Then either advances to the next clip or triggers feedback and ends the session.

**`FeedbackClient`** — sends a `FeedbackRequest` to the Feedback container and streams SSE tokens back to the client via a `SendFn`. The only class that knows about the Feedback container's HTTP API.

**`ServiceRouter`** — generic session-pinned router for any multi-instance backend service. Uses FNV-1a hashing so the same session ID always resolves to the same instance. Used by `Coordinator` for both Evaluation and Transcription URL resolution.

**`FileScenarioLoader`** — reads all scenario subdirectories at startup, parses and validates each `metadata.json`, and throws at construction time if any scenario is misconfigured. Implements `ScenarioLoader` — swap with any other implementation without touching the rest of the codebase.

`main.ts` wires these components together and handles the HTTP and WebSocket surface. Route handlers are intentionally thin — they translate between HTTP/WebSocket and the internal API with no business logic of their own.

---

## API

See `docs/api_contract.md` for the full wire format. See `docs/admin_and_tooling_api.md` for admin session creation and inter-container APIs.

| Method | Path                   | Description                                                                                                     |
|--------|------------------------|-----------------------------------------------------------------------------------------------------------------|
| `POST` | `/session/create`      | Create a session — returns active or queued. Pass `Authorization: Bearer <ADMIN_API_KEY>` for an admin session. |
| `POST` | `/session/:id/resume`  | Resume a dropped session within the recovery window                                                             |
| `POST` | `/session/:id/end`     | End a session explicitly (abnormal path only)                                                                   |
| `GET`  | `/session/:id/queue`   | Poll queue position                                                                                             |
| `GET`  | `/scenarios/:id/clips` | List all clips in a scenario (debugging and tooling)                                                            |
| `WS`   | `/ws/:session_id`      | Stream frames and audio, receive transcript updates and feedback                                                |
| `GET`  | `/health`              | Aggregated health across evaluation, transcription, and feedback                                                |

### WebSocket message types

| Direction       | Type               | Description                                                                                                                     |
|-----------------|--------------------|---------------------------------------------------------------------------------------------------------------------------------|
| Client → Server | `video_frame`      | Landmark data from MediaPipe                                                                                                    |
| Client → Server | `audio_chunk`      | PCM audio and pre-computed MFCCs                                                                                                |
| Client → Server | `clip_ended`       | Signals that a clip has finished playing                                                                                        |
| Client → Server | `get_scenarios`    | Request the list of available scenarios                                                                                         |
| Client → Server | `request_clip`     | Request clip metadata and video URL, with optional activation                                                                   |
| Server → Client | `session_update`   | Accumulated transcript so far — sent on each finalised Whisper segment                                                          |
| Server → Client | `clip_candidates`  | Full clip data for every possible next clip, sent immediately on `clip_ended` for parallel preloading                           |
| Server → Client | `clip_selected`    | The clip to play next and the clip score, sent once evaluation completes                                                        |
| Server → Client | `debug_eval`       | Full evaluation debug data — **admin sessions only**, sent immediately after `clip_selected`. Never sent to non-admin sessions. |
| Server → Client | `feedback_token`   | Streaming LLM token during debrief                                                                                              |
| Server → Client | `session_complete` | Final debrief when generation finishes                                                                                          |
| Server → Client | `error`            | Recoverable or fatal error                                                                                                      |

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All variables have defaults except those marked required.

| Variable              | Default   | Description                                                                                                                                                               |
|-----------------------|-----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `PORT`                | `3000`    | Internal listen port                                                                                                                                                      |
| `EVALUATION_URL`      | required  | Base URL of the Evaluation container. Treated as a comma-separated list — multiple values enable multi-instance load distribution                                         |
| `TRANSCRIPTION_URL`   | required  | Base URL of the Transcription container. Comma-separated list supported for multi-instance setups                                                                         |
| `FEEDBACK_URL`        | required  | Base URL of the Feedback container                                                                                                                                        |
| `SCENARIOS_DIR`       | required  | Path to the scenarios directory, mounted from the repo root                                                                                                               |
| `INTERNAL_API_KEY`    | required  | Shared secret sent as `Authorization: Bearer` on all requests to AI services. Generate with `openssl rand -hex 32`                                                        |
| `MAX_SESSIONS`        | `32`      | Maximum concurrent active sessions                                                                                                                                        |
| `MAX_QUEUE_SIZE`      | `10`      | Maximum sessions in the waiting queue                                                                                                                                     |
| `CAPACITY_POLICY`     | `QUEUE`   | `QUEUE` or `REJECT` when at capacity                                                                                                                                      |
| `SESSION_TIMEOUT_MS`  | `30000`   | ms to wait for WebSocket before dropping session                                                                                                                          |
| `RECOVERY_WINDOW_MS`  | `30000`   | ms a dropped session can be resumed                                                                                                                                       |
| `FEEDBACK_TIMEOUT_MS` | `150000`  | ms to wait for the full feedback SSE stream. Set slightly above the Feedback container's `OLLAMA_TIMEOUT_MS`.                                                             |
| `ADMIN_API_KEY`       | _(unset)_ | Optional. When set, requests to `POST /session/create` carrying `Authorization: Bearer <value>` create admin sessions. When unset, admin mode is permanently unavailable. |
| `CORS_ORIGIN`         | _(unset)_ | When unset, HTTP endpoints accept any origin (correct for single-server classroom use). Set to a specific origin for multi-host deployments.                              |

---

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests with UI
npm run test:ui

# Watch mode
npm run test:watch

# Type check without building
npm run typecheck

# Build
npm run build

# Run (after build)
npm start

# Dev mode with live reload (no build step)
npm run dev
```

---

## Testing

Tests live in `tests/` and are written with Vitest. Run the full suite with `npm test`.

| File                            | Coverage                                                                                                                                 |
|---------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `tests/session-manager.test.ts` | Session lifecycle, capacity, queue, state transitions, conversation history, admin mode                                                  |
| `tests/clip-session.test.ts`    | WebSocket lifecycle, audio queuing, transcript accumulation, thenable resolution, flush/timeout, language query param                    |
| `tests/coordinator.test.ts`     | Clip-scoped dispatch, transcript accumulation, reset behaviour, sequence tracking, language threading, debug header and payload handling |
| `tests/clip-controller.test.ts` | Clip transition sequence, branch resolution, turn construction, terminal and non-terminal paths, `debug_eval` message for admin sessions |
| `tests/feedback-client.test.ts` | SSE token streaming, request shape, failure handling                                                                                     |
| `tests/service-router.test.ts`  | Session pinning, instance distribution, WebSocket URL conversion                                                                         |
| `tests/scenario-loader.test.ts` | Scenario loading, metadata validation, error cases                                                                                       |

Time-dependent tests use `vi.useFakeTimers()` so recovery windows and session timeouts can be tested without real delays. Outbound HTTP calls are stubbed with `vi.stubGlobal("fetch", vi.fn())`. WebSocket connections in `ClipSession` tests are driven via an injected mock factory.

---

## Building with Docker

The Dockerfile expects the repo root as its build context. Always build via Docker Compose from the repo root:

```bash
docker compose up --build
```

Do not run `docker build` from inside `app/` — the build will fail because `shared/` will be outside the build context.