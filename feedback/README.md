# Feedback Container

The Feedback container is the last piece of the pipeline. Once the App container reaches a terminal clip, it compiles the full session history — every clip the student responded to, the behaviour analysis of each response, and the accumulated transcript — and sends it here as a single `FeedbackRequest`. The Feedback container formats a prompt, calls an Ollama LLM, and streams the result back to the App as Server-Sent Events. The App forwards those tokens over WebSocket to the client as `feedback_token` messages, then sends a final `session_complete` when generation finishes.

The container is entirely stateless. Each request is self-contained — no session state is held here.

---

## Responsibilities

- **Prompt assembly** — formats the full `ConversationHistory` (clips, student transcripts, behaviour analysis) into a structured debrief prompt in the session's target language
- **LLM generation** — calls Ollama's `/api/generate` endpoint for streaming inference
- **SSE streaming** — returns generated tokens as `text/event-stream` during generation, followed by a `complete` event carrying the assembled `Feedback` object
- **Non-streaming fallback** — `POST /feedback/generate` waits for full generation and returns the `Feedback` object as JSON; used for testing and tooling
- **Health reporting** — `GET /feedback/health` reports whether Ollama is reachable and which model is loaded

---

## Architecture

### Classes

**`FeedbackGeneratorInterface`** — abstract base defining two methods that all implementations must provide:

```typescript
abstract generate(req: FeedbackRequest): Promise<Feedback>;
abstract generateStream(req: FeedbackRequest): AsyncGenerator<string>;
```

**`OllamaFeedbackGenerator`** — production implementation. Formats the `FeedbackRequest` history into a prompt, calls `POST {OLLAMA_HOST}/api/generate` with `stream: true`, and yields tokens as they arrive. On stream end it assembles the final `Feedback` object (including `severity` and `highlights`) by parsing the full generated text. Used when `FEEDBACK_GENERATOR=production`.

**`StubFeedbackGenerator`** — development implementation. Returns a canned Dutch `Feedback` object without calling Ollama. `generateStream()` splits the advice word by word and yields tokens with a small artificial delay to simulate realistic streaming. Used when `FEEDBACK_GENERATOR=stub` (the default). See `docs/stub_guide.md` for the full specification.

**`FeedbackService`** — thin orchestration layer. Instantiates the correct `FeedbackGeneratorInterface` implementation via a factory function keyed on the `FEEDBACK_GENERATOR` env variable. Route handlers in `main.ts` delegate directly to this service.

The Fastify route layer in `main.ts` is intentionally thin — each route handler calls one `FeedbackService` method, sets the appropriate `Content-Type`, and writes the response. No business logic lives in route handlers.

### Startup model management

When `FEEDBACK_GENERATOR=production`, the container runs `ensureModel()` during startup before the `OllamaFeedbackGenerator` is instantiated. This guarantees the required model is available before any request is served. The sequence is:

1. Check whether the model is already present via `GET /api/tags`.
2. If absent, pull it via `POST /api/pull` (blocking, up to `OLLAMA_PULL_TIMEOUT_MS`). On failure the container exits with code 1.
3. If `OLLAMA_MODEL_DIGEST` is set, verify the model's digest via `POST /api/show`. On mismatch the container exits with code 1, logging the expected and actual digest values.
4. Log success — model name and digest (if verified).

The stub path bypasses `ensureModel` entirely — no Ollama interaction occurs when `FEEDBACK_GENERATOR=stub`.

### Shared types dependency

The Feedback container imports `FeedbackRequest`, `ConversationTurn`, `ClipMetadata`, `BehaviourResult`, and `Feedback`-related types from `@ar-training/shared`. These are the TypeScript DTOs that the App container also uses when constructing the `FeedbackRequest` body — sharing the package keeps the shapes in sync without duplication.

```json
// feedback/package.json
{
    "dependencies": {
        "@ar-training/shared": "file:../shared"
    }
}
```

---

## API

See `docs/api_contract.md` for the full wire format.

All endpoints except `/feedback/health` require `Authorization: Bearer <INTERNAL_API_KEY>`.

| Method | Path                        | Auth     | Description                                                  |
|--------|-----------------------------|----------|--------------------------------------------------------------|
| `POST` | `/feedback/generate`        | Required | Generate full debrief and return as JSON                     |
| `POST` | `/feedback/generate/stream` | Required | Generate debrief and stream as SSE — primary production path |
| `GET`  | `/feedback/health`          | None     | Ollama reachability and loaded model name                    |

### `POST /feedback/generate`

**Request body** — `FeedbackRequest`
```json
{
    "session_id": "string",
    "scenario_id": "string",
    "language": "string",
    "history": [
        {
            "turn_id": "integer",
            "clip": "ClipMetadata",
            "student_response": "BehaviourResult",
            "student_transcript": "string"
        }
    ]
}
```

**Response 200** — `Feedback`
```json
{
    "session_id": "string",
    "advice": "string",
    "severity": "low | medium | high",
    "highlights": ["string"]
}
```

**Response 401** — missing or invalid `Authorization` header.

### `POST /feedback/generate/stream`

Same request body as `/feedback/generate`.

**Response** — `text/event-stream`

Token events during generation:
```
data: {"type": "token", "token": "string"}\n\n
```

Final event once generation completes:
```
data: {"type": "complete", "feedback": { ...Feedback... }}\n\n
```

This is the endpoint called by `FeedbackClient` in the App container (`app/src/feedback-client.ts`). The App parses `token` events into `feedback_token` WebSocket messages and the `complete` event into a `session_complete` WebSocket message.

**Response 401** — missing or invalid `Authorization` header.

### `GET /feedback/health`

No authentication required.

**Response 200**
```json
{
    "status": "ok",
    "ollama_reachable": "boolean",
    "model": "string"
}
```

When Ollama is unreachable, `ollama_reachable` is `false` but the response is still `200` — the container is up, just degraded. The App container checks this field and reports `feedback: { status: "unreachable" }` in its own aggregated health response.

---

## Configuration

Copy `.env.example` to `.env` and set `INTERNAL_API_KEY`. All other variables have defaults.

| Variable                 | Default               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|--------------------------|-----------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `PORT`                   | `8002`                | Internal listen port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `INTERNAL_API_KEY`       | _(required)_          | Shared secret. All requests must carry `Authorization: Bearer <INTERNAL_API_KEY>`. Generate with `openssl rand -hex 32` and set the same value in `app/.env`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `FEEDBACK_GENERATOR`     | `stub`                | `stub` — canned responses, no Ollama; `production` — real `OllamaFeedbackGenerator`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `OLLAMA_HOST`            | `http://ollama:11434` | Base URL of the Ollama instance. Override to use an external Ollama server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `OLLAMA_MODEL`           | `llama3.2`            | The Ollama model name to use for generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `OLLAMA_TIMEOUT_MS`      | `120000`              | How long to wait for Ollama to respond during generation before aborting (ms). Distinct from `OLLAMA_PULL_TIMEOUT_MS`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `OLLAMA_MODEL_DIGEST`    | _(unset)_             | Optional. When set, must be the exact SHA-256 digest of the expected Ollama model manifest in the form `sha256:<64 hex chars>`. At startup the container verifies the model digest matches; if it does not, startup fails with a clear error. When unset, digest verification is skipped. **Operators should set this in production deployments** to prevent a compromised or substituted registry entry from causing an unintended model to be used. The correct digest for a model can be found by running `ollama show <model>` and copying the `digest` field |
| `OLLAMA_PULL_TIMEOUT_MS` | `600000`              | How long to wait for a model pull to complete before treating it as failed (ms). Large models can take several minutes to download; the default is 10 minutes. Distinct from `OLLAMA_TIMEOUT_MS` which governs generation requests                                                                                                                                                                                                                                                                                                                                |

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

# Dev mode with live reload
npm run dev
```

### Running with the stub (recommended)

By default, `FEEDBACK_GENERATOR=stub` — no Ollama instance is required. The stub returns a hardcoded Dutch debrief and simulates token streaming, so the full pipeline can be exercised without a running LLM.

```bash
# Start just the containers you need (omit ollama)
docker compose up app client transcription evaluation feedback
```

### Running with Ollama

To test real generation, pull the model first (only needed once — persisted in a Docker volume). The `ollama/ollama` image runs a server as its entrypoint, so the pull must be done by exec-ing into a running container:

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull llama3.2
```

Then set `FEEDBACK_GENERATOR=production` in `feedback/.env` and start the full stack:

```bash
docker compose up
```

When `FEEDBACK_GENERATOR=production`, the container will automatically pull the model at startup if it is not already present. The manual pull above is therefore optional — it is useful when you want to pre-warm the model image in a separate step rather than waiting during the first `docker compose up`.

Ollama model loading can take up to 60 seconds on first start. The healthcheck has a `start_period` of 60 s to accommodate this.

---

## Testing

Tests live in `tests/` and are written with Vitest.

| File                               | Coverage                                                                                                                         |
|------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| `tests/feedback-generator.test.ts` | Stub behaviour — correct canned text, `severity`, `highlights` referencing first and last turn; streaming yields tokens          |
| `tests/feedback-service.test.ts`   | Factory wires correct implementation; delegates to generator                                                                     |
| `tests/routes.test.ts`             | Auth enforcement on all protected endpoints; `POST /feedback/generate` response shape; SSE stream format; health response shapes |

---

## Building with Docker

The Dockerfile expects the repo root as its build context. Always build via Docker Compose from the repo root:

```bash
docker compose up --build
```

Do not run `docker build` from inside `feedback/` — the build will fail because `shared/` will be outside the build context.