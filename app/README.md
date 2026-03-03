# App Container

The App container is the single entry point for all clients. It manages session lifecycle, assembles incoming webcam and audio data into analysis windows, coordinates clip transitions, and delivers feedback at session end.

No ML models are loaded here — all processing is delegated to the Evaluation and Feedback containers.

---

## Responsibilities

- **Session management** — capacity enforcement, queue management, state transitions, and recovery from dropped connections
- **Window assembly** — accumulates `VideoFrame` and `AudioChunk` messages into ~2s `AnalysisWindow` objects and dispatches them to the Evaluation container
- **Result routing** — forwards `BehaviourResult` scores back to the client as `SessionUpdate` messages over WebSocket
- **Clip transitions** — on `ClipEnded`, flushes the current window, resolves the next clip from branch conditions, commits a `ConversationTurn`, and notifies the client via `ClipReady`
- **Feedback delivery** — at session end, compiles the full `ConversationTurn` history into a `FeedbackRequest` and streams the LLM debrief back to the client token by token

---

## Architecture

### Classes

**`SessionManager`** — owns session state. Tracks every session from creation through completion or expiry, enforces capacity limits, manages the waiting queue, and preserves session state across dropped connections within the recovery window.

**`Coordinator`** — owns the data pipeline for each active session. Buffers incoming frames and audio, assembles analysis windows on a 2-second timer, dispatches windows to the Evaluation container, and accumulates per-clip escalation scores.

**`ClipController`** — owns the clip transition sequence. On receiving a `ClipEnded` message it flushes the coordinator, computes the clip's average score, resolves the next clip from branch conditions, appends a `ConversationTurn` to session history, resets the evaluation audio buffer, and either advances to the next clip or triggers feedback and ends the session.

**`FeedbackClient`** — sends a `FeedbackRequest` to the Feedback container and streams SSE tokens back to the client via a `SendFn`. The only class that knows about the Feedback container's HTTP API.

**`EvaluationRouter`** — selects which Evaluation instance to use for a given session and keeps that mapping stable for the session's lifetime (session pinning). Uses FNV-1a hashing so the same session ID always resolves to the same instance, keeping per-session Whisper VAD buffers coherent.

**`FileScenarioLoader`** — reads all scenario subdirectories at startup, parses and validates each `metadata.json`, and throws at construction time if any scenario is misconfigured. Implements `ScenarioLoader` — swap with any other implementation without touching the rest of the codebase.

`main.ts` wires these components together and handles the HTTP and WebSocket surface. Route handlers are intentionally thin — they translate between HTTP/WebSocket and the internal API with no business logic of their own.

---

## API

See `docs/api_contract.md` for the full wire format.

| Method | Path                  | Description                                                    |
|--------|-----------------------|----------------------------------------------------------------|
| `POST` | `/session/create`     | Create a session — returns active or queued                    |
| `POST` | `/session/:id/resume` | Resume a dropped session within the recovery window            |
| `POST` | `/session/:id/end`    | End a session explicitly (abnormal path)                       |
| `GET`  | `/session/:id/queue`  | Poll queue position                                            |
| `WS`   | `/ws/:session_id`     | Stream frames and audio, receive updates and feedback          |
| `GET`  | `/health`             | Aggregated health across all evaluation instances and feedback |

### WebSocket message types

| Direction       | Type               | Description                                    |
|-----------------|--------------------|------------------------------------------------|
| Client → Server | `video_frame`      | Landmark data from MediaPipe                   |
| Client → Server | `audio_chunk`      | PCM audio and pre-computed MFCCs               |
| Client → Server | `clip_ended`       | Signals that a clip has finished playing       |
| Server → Client | `session_update`   | Escalation score after each analysis window    |
| Server → Client | `clip_ready`       | Next clip ID and clip score after a transition |
| Server → Client | `feedback_token`   | Streaming LLM token during debrief             |
| Server → Client | `session_complete` | Final debrief when generation finishes         |
| Server → Client | `error`            | Recoverable or fatal error                     |

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All variables have defaults except those marked required.

| Variable                | Default  | Description                                                                                                                       |
|-------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------|
| `PORT`                  | `3000`   | Internal listen port                                                                                                              |
| `EVALUATION_URL`        | required | Base URL of the Evaluation container. Treated as a comma-separated list — multiple values enable multi-instance load distribution |
| `FEEDBACK_URL`          | required | Base URL of the Feedback container                                                                                                |
| `SCENARIOS_DIR`         | required | Path to the scenarios directory, mounted from the repo root                                                                       |
| `INTERNAL_API_KEY`      | required | Shared secret sent as `Authorization: Bearer` on all requests to Evaluation and Feedback. Generate with `openssl rand -hex 32`    |
| `MAX_SESSIONS`          | `32`     | Maximum concurrent active sessions                                                                                                |
| `MAX_QUEUE_SIZE`        | `10`     | Maximum sessions in the waiting queue                                                                                             |
| `CAPACITY_POLICY`       | `QUEUE`  | `QUEUE` or `REJECT` when at capacity                                                                                              |
| `SESSION_TIMEOUT_MS`    | `30000`  | ms to wait for WebSocket before dropping session                                                                                  |
| `RECOVERY_WINDOW_MS`    | `30000`  | ms a dropped session can be resumed                                                                                               |
| `WINDOW_MS`             | `2000`   | Analysis window duration in ms                                                                                                    |
| `MIN_FRAMES_PER_WINDOW` | `10`     | Minimum frames required to dispatch a window                                                                                      |

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

| File                              | Coverage                                                                                        |
|-----------------------------------|-------------------------------------------------------------------------------------------------|
| `tests/session-manager.test.ts`   | Session lifecycle, capacity, queue, state transitions, conversation history                     |
| `tests/coordinator.test.ts`       | Window assembly, evaluation communication, clip management, last result tracking                |
| `tests/clip-controller.test.ts`   | Clip transition sequence, branch resolution, turn construction, terminal and non-terminal paths |
| `tests/feedback-client.test.ts`   | SSE token streaming, request shape, failure handling                                            |
| `tests/evaluation-router.test.ts` | Session pinning, instance distribution, WebSocket URL conversion                                |
| `tests/scenario-loader.test.ts`   | Scenario loading, metadata validation, error cases                                              |

Time-dependent tests use `vi.useFakeTimers()` so recovery windows and session timeouts can be tested without real delays. Outbound HTTP calls are stubbed with `vi.stubGlobal("fetch", vi.fn())`.

---

## Building with Docker

The Dockerfile expects the repo root as its build context. Always build via Docker Compose from the repo root:

```bash
docker compose up --build
```

Do not run `docker build` from inside `app/` — the build will fail because `shared/` will be outside the build context.