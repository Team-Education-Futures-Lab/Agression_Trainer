# Contributing & Developer Setup

---

## Tech Stack

| Container     | Language   | Framework                           |
|---------------|------------|-------------------------------------|
| Client        | TypeScript | React, Vite, MediaPipe.js, Meyda.js |
| App           | TypeScript | Node.js, Fastify, ws                |
| Transcription | Python     | FastAPI, faster-whisper             |
| Evaluation    | Python     | FastAPI                             |
| Feedback      | TypeScript | Node.js, Fastify                    |
| Ollama        | —          | Existing Docker image               |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose plugin on Linux)
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) — only if using a GPU
- Git

No local Python or Node installation is required for deployment. Everything runs inside containers.

---

## First-Time Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd ar-training

# 2. Copy the example environment file and fill in INTERNAL_API_KEY
cp .env.example .env

# 3. Pull the Ollama model (only needed once — stored in models/ on the host)
#    The ollama/ollama image runs a server as its entrypoint, so the pull must
#    be done by exec-ing into a running container rather than via `run`.
docker compose up -d ollama
docker compose exec ollama ollama pull llama3.2

# 4. Start the full stack
docker compose up --build
```

The app will be available at `http://localhost:3000` (client) and `http://localhost:3001` (app API).

---

## Running with Stubs (Recommended for Development)

During development, use stub AI implementations so you don't need a trained classifier or a running Ollama instance. Set the following in `app/.env`:

```bash
BEHAVIOUR_ANALYSER=stub
FEEDBACK_GENERATOR=stub
```

And in `transcription/.env`:

```bash
TRANSCRIPTION_POOL=stub
```

Then start only the containers you need:

```bash
# Omit Ollama — stubs don't need it
docker compose up app client transcription evaluation feedback
```

The Transcription container has a real Whisper implementation (`TRANSCRIPTION_POOL=production`) available whenever you need actual transcription quality — it is not gated on a separate model file. See `stub_guide.md` for details on all stub behaviours.

---

## Environment Variables

### App container (`app/.env`)

| Variable              | Default                     | Description                                                                                                                                                                                                                       |
|-----------------------|-----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`    | _(required)_                | Shared secret for all App→AI service requests. Generate once with `openssl rand -hex 32` and set the same value in all containers.                                                                                                |
| `EVALUATION_URL`      | `http://evaluation:8001`    | Evaluation instance URL(s). Comma-separated list enables multi-instance load distribution with session pinning.                                                                                                                   |
| `TRANSCRIPTION_URL`   | `http://transcription:8003` | Transcription instance URL(s). Comma-separated list supported for multi-instance setups.                                                                                                                                          |
| `FEEDBACK_URL`        | `http://feedback:8002`      | Feedback service URL.                                                                                                                                                                                                             |
| `SCENARIOS_DIR`       | _(required)_                | Path to the scenarios directory, mounted from the repo root at runtime.                                                                                                                                                           |
| `BEHAVIOUR_ANALYSER`  | `stub`                      | `stub` or `production`. Selects the Evaluation container's analyser implementation.                                                                                                                                               |
| `FEEDBACK_GENERATOR`  | `stub`                      | `stub` or `production`. Selects the Feedback container's generator implementation.                                                                                                                                                |
| `MAX_SESSIONS`        | `32`                        | Maximum concurrent active sessions.                                                                                                                                                                                               |
| `MAX_QUEUE_SIZE`      | `10`                        | Maximum sessions held in the waiting queue.                                                                                                                                                                                       |
| `CAPACITY_POLICY`     | `QUEUE`                     | `QUEUE` or `REJECT` when at capacity.                                                                                                                                                                                             |
| `SESSION_TIMEOUT_MS`  | `30000`                     | ms to wait for a WebSocket connection + activation before dropping a session.                                                                                                                                                     |
| `RECOVERY_WINDOW_MS`  | `30000`                     | ms a dropped session can be resumed before it expires.                                                                                                                                                                            |
| `FEEDBACK_TIMEOUT_MS` | `150000`                    | ms to wait for the full feedback SSE stream before treating it as unavailable. Should exceed the Feedback container's `OLLAMA_TIMEOUT_MS` to allow Ollama to time out first.                                                      |
| `CORS_ORIGIN`         | _(unset — allows any)_      | When unset, HTTP endpoints accept requests from any origin (correct for single-server classroom use). Set to a specific origin (e.g. `http://localhost:3000`) in multi-host or internet-facing deployments.                       |
| `ADMIN_API_KEY`       | _(unset)_                   | Optional. When set, `POST /session/create` requests carrying `Authorization: Bearer <value>` create admin sessions that can activate any clip. When unset, admin mode is permanently unavailable. See `admin_and_tooling_api.md`. |
| `PORT`                | `3000`                      | Internal listen port.                                                                                                                                                                                                             |

### Transcription container (`transcription/.env`)

| Variable             | Default      | Description                                                                          |
|----------------------|--------------|--------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_ | Must match the value in `app/.env`.                                                  |
| `TRANSCRIPTION_POOL` | `stub`       | `stub` — canned responses, no Whisper; `production` — real WhisperPool.              |
| `WHISPER_MODEL`      | `base`       | faster-whisper model size: `tiny`, `base`, `small`, `medium`, `large-v3`.            |
| `WHISPER_LANGUAGE`   | `nl`         | ISO 639-1 language code passed to Whisper.                                           |
| `WHISPER_WORKERS`    | `4`          | Number of `WhisperModel` instances in the pool — controls transcription parallelism. |
| `DEVICE`             | `cpu`        | `cpu` or `cuda`. CUDA requires the NVIDIA Container Toolkit.                         |
| `PORT`               | `8003`       | Internal listen port.                                                                |

### Evaluation container (`evaluation/.env`)

| Variable             | Default      | Description                                                                                  |
|----------------------|--------------|----------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_ | Must match the value in `app/.env`.                                                          |
| `BEHAVIOUR_ANALYSER` | `stub`       | `stub` — deterministic canned results; `production` — real multimodal classifier.            |
| `DEVICE`             | `cpu`        | `cpu` or `cuda`. CUDA requires the NVIDIA Container Toolkit.                                 |
| `PORT`               | `8001`       | Internal listen port.                                                                        |

### Feedback container (`feedback/.env`)

| Variable             | Default               | Description                                                                                          |
|----------------------|-----------------------|------------------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_          | Must match the value in `app/.env`.                                                                  |
| `FEEDBACK_GENERATOR` | `stub`                | `stub` — canned Dutch feedback, no Ollama; `production` — calls Ollama to generate real feedback.    |
| `OLLAMA_HOST`        | `http://ollama:11434` | Base URL of the Ollama instance. Override to use an external Ollama server.                          |
| `OLLAMA_MODEL`       | `llama3.2`            | The Ollama model name to use for generation.                                                         |
| `OLLAMA_TIMEOUT_MS`  | `120000`              | How long to wait for Ollama to respond before aborting the request (ms).                             |
| `PORT`               | `8002`                | Internal listen port.                                                                                |

---

## Project Structure

This is a monorepo — one repository containing all services. Each service is a self-contained directory with its own dependencies, Dockerfile, and `.gitignore`. There is no reason for one service to access files from another service's directory at runtime; communication happens exclusively over HTTP and WebSocket as defined in `api_contract.md`.

```
ar-training/
├── app/                        ← App container (TypeScript / Node)
│   │                             Handles WebSocket connections, session lifecycle,
│   │                             and routes data between client and AI services.
│   ├── src/
│   ├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── .env                    ← Local env (not committed — copy from .env.example)
│   ├── README.md
│   └── .gitignore
│
├── transcription/              ← Transcription container (Python)
│   │                             Runs faster-whisper with VAD for continuous
│   │                             per-clip audio transcription.
│   ├── src/
│   │   └── stubs/              ← StubTranscriptionPool
│   ├── tests/
│   ├── requirements.txt
│   ├── pytest.ini
│   ├── Dockerfile
│   ├── .env                    ← Local env (not committed — copy from .env.example)
│   ├── README.md
│   └── .gitignore
│
├── evaluation/                 ← Evaluation container (Python)
│   │                             Runs the multimodal behaviour classifier.
│   │                             Receives complete clip windows with full transcripts.
│   │                             GPU-optional, horizontally scalable.
│   ├── src/
│   │   └── stubs/              ← StubBehaviourAnalyser
│   ├── tests/
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── .env                    ← Local env (not committed — copy from .env.example)
│   ├── README.md
│   └── .gitignore
│
├── feedback/                   ← Feedback container (TypeScript / Node)
│   │                             Wraps Ollama to generate end-of-session debrief advice.
│   ├── src/
│   ├── tests/
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   ├── .env                    ← Local env (not committed — copy from .env.example)
│   ├── README.md
│   └── .gitignore
│
├── client/                     ← Browser client (TypeScript / React)
│   │                             Captures webcam and microphone, extracts landmarks
│   │                             and audio features, communicates with the App container.
│   │                             Served by its own Nginx instance in production.
│   ├── src/
│   ├── public/                 ← Static assets (MediaPipe WASM etc, not committed)
│   ├── scripts/                ← Build-time helpers (copies WASM from node_modules)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── nginx.conf              ← Nginx config for the production Docker image
│   ├── Dockerfile
│   ├── README.md
│   └── .gitignore
│
├── shared/                     ← Shared TypeScript types (not a runnable service)
│   │                             Single source of truth for all DTOs that cross
│   │                             container boundaries. Referenced as a local npm
│   │                             dependency by app/, feedback/, and client/.
│   ├── types.ts
│   └── package.json
│
├── scenarios/                  ← Scenario content (video + metadata)
│   │                             Each subdirectory is one scenario. Video files
│   │                             are tracked with Git LFS.
│   └── scenario_01/
│       ├── metadata.json       ← Clip definitions, transcripts, branch conditions
│       └── *.mp4
│
├── models/                     ← Ollama model storage and trained ML model files
│   │                             Bind-mounted into the Ollama container at
│   │                             /root/.ollama so pulled models are visible on the
│   │                             host and persist across container recreation.
│   │                             Also used for classifier.pkl (provided separately).
│   └── classifier.pkl          ← Provided separately, mounted at runtime
│
├── docs/                       ← Project-level documentation
│   ├── architecture.md
│   ├── api_contract.md         ← Client-facing session and WebSocket API
│   ├── admin_and_tooling_api.md← Operator endpoints and inter-container APIs
│   ├── session_lifecycle.md
│   ├── stub_guide.md
│   ├── scenario_schema.md
│   └── dev_setup.md            ← This file
│
├── docker-compose.yml
└── .gitignore                  ← Repo-wide: .env, *.log, .DS_Store
```

---

## Building with Docker

All Dockerfiles expect the build context to be the **repo root**, not the service directory. This is required because services that depend on `shared/` need it to be in scope during the build.

Always build via `docker compose` from the repo root:

```bash
docker compose up --build
```

Do not run `docker build` directly inside a service directory — the build will fail because `shared/` will be outside the build context.

---

## Shared Types

The `shared/` package contains TypeScript type definitions used by `app/`, `feedback/`, and `client/`. Reference it as a local dependency:

```json
// app/package.json, feedback/package.json, client/package.json
{
    "dependencies": {
        "@ar-training/shared": "file:../shared"
    }
}
```

The Python `transcription/` and `evaluation/` containers define their own dataclasses in `src/interfaces.py` — these mirror the shared TypeScript types and the JSON shapes in `api_contract.md`.

---

## IDE Setup

**Recommended: WebStorm** opened at the repo root. WebStorm discovers all `package.json` files automatically and provides full IntelliSense across all TypeScript services including cross-service resolution of the `shared/` package. Mark `scenarios/`, `models/`, and `docs/` as excluded directories (Settings → Directories) to prevent WebStorm from indexing video files and keep search fast.

For Python containers, open each service directory separately in **PyCharm** with a Python interpreter pointing at the service's `.venv` for full IntelliSense and test runner integration. WebStorm provides basic Python syntax support but PyCharm is recommended for any significant Python work.

**Alternative: VS Code** at the repo root with the Pylance, ESLint, and Docker extensions handles all languages in one window.

---

## Useful Commands

```bash
# Start full stack
docker compose up

# Start with rebuilt images (after code changes)
docker compose up --build

# Start without Ollama (all stubs active)
docker compose up app client transcription evaluation feedback

# Scale transcription or evaluation workers
docker compose up --scale transcription=3
docker compose up --scale evaluation=3

# View logs for a specific container
docker compose logs -f feedback

# Pull an Ollama model (stored in models/ on the host — only needed once)
docker compose up -d ollama
docker compose exec ollama ollama pull llama3.2

# Run TypeScript tests (App container)
docker compose run --rm app npm test

# Run TypeScript tests (Feedback container)
docker compose run --rm feedback npm test

# Run Python tests (Transcription container)
docker compose run --rm transcription python -m pytest

# Run Python tests (Evaluation container)
docker compose run --rm evaluation python -m pytest

# Run Python tests locally (from service directory with venv active)
pytest -v

# Stop everything (Ollama models are preserved in models/ on the host)
docker compose down

# Stop and remove all Docker volumes
# Note: Ollama models are now stored in models/ (a bind mount), not a Docker
# volume, so they are NOT removed by this command. Use this only to reset
# other state.
docker compose down -v
```

---

## Adding a New Scenario

1. Create a directory under `scenarios/` named after your `scenario_id`
2. Add video clips as `.mp4` files
3. Create `metadata.json` following the schema in `scenario_schema.md`
4. Verify the branching graph has no dead ends (every non-terminal clip must have conditions covering `-1.0` to `1.0`)
5. Restart the App container — scenarios are loaded at startup
6. Verify with `GET /scenarios/{scenario_id}/clips` (see `admin_and_tooling_api.md`) to confirm all clips loaded correctly

---

## Implementing a Real AI Component

Each AI component has a corresponding interface in its container's source directory. To add a real implementation:

1. Create a new file in the appropriate container's source directory
2. Subclass (Python) or implement (TypeScript) the relevant interface
3. Implement all abstract methods
4. Register the new implementation in the container's factory function (see `stub_guide.md` for the pattern)
5. Set the corresponding environment variable in the container's `.env`

The rest of the system requires no changes.

---

## Code Style

**TypeScript (App, Feedback, Client)**
- TypeScript strict mode enabled (`erasableSyntaxOnly: true` — no parameter properties)
- Interfaces for all data transfer objects — defined once in `shared/types.ts` and imported by all TypeScript services and the client
- Abstract classes / interfaces for all swappable components
- No business logic in entrypoints (`main.ts`, `App.tsx`) — delegate to implementations

**Python (Transcription, Evaluation)**
- Python 3.11+
- Type hints on all function signatures
- Dataclasses for all data transfer objects
- Abstract base classes for all swappable components
- No business logic in entrypoints (`main.py`) — delegate to interface implementations