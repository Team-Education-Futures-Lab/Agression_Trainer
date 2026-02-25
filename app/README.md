# App Container

The App container is the single entry point for all clients. It manages session lifecycle, assembles incoming webcam and audio data into analysis windows, and coordinates communication between the client, the Evaluation container, and the Feedback container.

No ML models are loaded here — all processing is delegated to downstream services.

---

## Responsibilities

- **Session management** — capacity enforcement, queue management, state transitions, and recovery from dropped connections
- **Window assembly** — accumulates `VideoFrame` and `AudioChunk` messages into ~2s `AnalysisWindow` objects and dispatches them to the Evaluation container
- **Result routing** — forwards `BehaviourResult` scores back to the client as `SessionUpdate` messages over WebSocket
- **Feedback delivery** — at session end, compiles the full `ConversationTurn` history into a `FeedbackRequest` and streams the LLM debrief back to the client token by token

---

## Architecture

Two internal components handle the core logic:

**`SessionManager`** — owns session state. Tracks every session from creation through completion or expiry, enforces capacity limits, manages the waiting queue, and preserves session state across dropped connections within the recovery window.

**`Coordinator`** — owns the data pipeline for each active session. Buffers incoming frames and audio, assembles analysis windows on a 2-second timer, dispatches windows to the Evaluation container, accumulates per-clip escalation scores, and streams feedback tokens to the client at session end.

`main.ts` wires these two components together and handles the HTTP and WebSocket surface. Route handlers are intentionally thin — they translate between HTTP/WebSocket and the internal API with no business logic of their own.

---

## API

See `docs/API_CONTRACT.md` for the full wire format. Summary:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/session/create` | Create a session — returns active or queued |
| `POST` | `/session/:id/resume` | Resume a dropped session within the recovery window |
| `POST` | `/session/:id/end` | End a session and trigger feedback generation |
| `GET`  | `/session/:id/queue` | Poll queue position |
| `WS`   | `/ws/:session_id` | Stream frames and audio, receive updates and feedback |
| `GET`  | `/health` | Health check |

---

## Configuration

Copy `.env.example` to `.env` and adjust as needed. All variables have defaults except `EVALUATION_URL` and `FEEDBACK_URL` which are required.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Internal listen port |
| `EVALUATION_URL` | — | Base URL of the Evaluation container |
| `FEEDBACK_URL` | — | Base URL of the Feedback container |
| `MAX_SESSIONS` | `32` | Maximum concurrent active sessions |
| `MAX_QUEUE_SIZE` | `10` | Maximum sessions in the waiting queue |
| `CAPACITY_POLICY` | `QUEUE` | `QUEUE` or `REJECT` when at capacity |
| `SESSION_TIMEOUT_MS` | `30000` | ms to wait for WebSocket before dropping session |
| `RECOVERY_WINDOW_MS` | `30000` | ms a dropped session can be resumed |
| `WINDOW_MS` | `2000` | Analysis window duration in ms |
| `MIN_FRAMES_PER_WINDOW` | `10` | Minimum frames to dispatch a window |

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

### Stub implementations

The `ScenarioLoader` defaults to `StubScenarioLoader` which returns a hardcoded scenario so the full pipeline can be exercised before real scenario files exist. Switch to `FileScenarioLoader` once `scenarios/` is populated.

The Evaluation and Feedback containers have their own stub implementations controlled by environment variables — see `docs/STUBS.md`.

---

## Testing

Tests live in `tests/` and are written with Vitest. Run the full suite with `npm test`.

| File | Coverage |
|------|----------|
| `tests/session-manager.test.ts` | Session lifecycle, capacity, queue, state transitions |
| `tests/coordinator.test.ts` | Window assembly, evaluation communication, clip management, SendFn lifecycle |

Time-dependent tests use `vi.useFakeTimers()` so recovery windows and session timeouts can be tested without real delays.

---

## Building with Docker

The Dockerfile expects the repo root as its build context. Always build via Docker Compose from the repo root:

```bash
docker compose up --build
```

Do not run `docker build` from inside `app/` — the build will fail because `shared/` will be outside the build context.