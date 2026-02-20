# Contributing & Developer Setup

---

## Tech Stack

| Container  | Language   | Framework                            |
|------------|------------|--------------------------------------|
| Client     | TypeScript | Browser APIs, MediaPipe.js, Meyda.js |
| App        | TypeScript | Node.js, Fastify, ws                 |
| Nginx      | —          | Config only, replaces custom proxy   |
| Evaluation | Python     | FastAPI, faster-whisper              |
| Feedback   | TypeScript | Node.js, Fastify                     |
| Ollama     | —          | Existing Docker image                |

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose plugin on Linux)
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) — only if using a GPU
- Git

No local Python or Node installation is required. Everything runs inside containers.

---

## First-Time Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd ar-training

# 2. Copy the example environment file
cp .env.example .env

# 3. Pull the Ollama model (only needed once — persisted in a Docker volume)
docker compose run --rm ollama ollama pull llama3.2

# 4. Start the full stack
docker compose up --build
```

The app will be available at `http://localhost:8000`.

---

## Running with Stubs (Recommended for Development)

During development, you almost certainly want stub AI implementations so you don't need a trained classifier or a running Ollama instance. Set the following in `.env`:

```bash
BEHAVIOUR_ANALYSER=stub
FEEDBACK_GENERATOR=stub
```

Then start only the containers you need:

```bash
# Run without the Ollama sidecar (stub doesn't need it)
docker compose up app proxy evaluation feedback
```

See `STUBS.md` for details on stub behavior.

---

## Environment Variables

All configuration lives in `.env`. The full reference is in `.env.example`. The most commonly changed variables during development:

| Variable             | Default               | Description                                   |
|----------------------|-----------------------|-----------------------------------------------|
| `BEHAVIOUR_ANALYSER` | `stub`                | `stub` or `production`                        |
| `FEEDBACK_GENERATOR` | `stub`                | `stub` or `production`                        |
| `WHISPER_MODEL`      | `base`                | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_LANGUAGE`   | `nl`                  | ISO 639-1 language code                       |
| `WHISPER_WORKERS`    | `4`                   | Whisper instances in the pool                 |
| `DEVICE`             | `cpu`                 | `cpu` or `cuda`                               |
| `FEEDBACK_MODEL`     | `llama3.2`            | Ollama model name                             |
| `OLLAMA_HOST`        | `http://ollama:11434` | Override to use external Ollama               |

---

## Project Structure

This is a monorepo — one repository containing all services. Each service is a self-contained directory with its own dependencies, Dockerfile, and `.gitignore`. There is no reason for one service to access files from another service's directory at runtime; communication happens exclusively over HTTP and WebSocket as defined in `docs/API_CONTRACT.md`.

```
ar-training/
├── app/                        ← App container (TypeScript / Node)
│   ├── src/
│   │   ├── sessionManager.ts
│   │   ├── coordinator.ts
│   │   └── main.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .gitignore              ← ignores node_modules/, dist/
│
├── evaluation/                 ← Evaluation container (Python)
│   ├── src/
│   │   ├── interfaces.py
│   │   ├── transcription.py
│   │   ├── behaviour_analyser.py
│   │   ├── stubs/
│   │   │   └── behaviour_analyser.py
│   │   └── main.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .gitignore              ← ignores __pycache__/, .venv/
│
├── feedback/                   ← Feedback container (TypeScript / Node)
│   ├── src/
│   │   ├── feedbackGenerator.ts
│   │   └── main.ts
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .gitignore
│
├── client/                     ← Browser client (TypeScript)
│   ├── src/
│   │   ├── capture.ts
│   │   └── responseHandler.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── .gitignore
│
├── shared/                     ← Shared TypeScript types
│   ├── types.ts                ← single source of truth for all TS DTOs
│   └── package.json            ← referenced as file:../shared in TS services
│
├── nginx/
│   └── nginx.conf
│
├── scenarios/
│   └── scenario_01/
│       ├── metadata.json
│       └── *.mp4
│
├── models/
│   └── classifier.pkl          ← not committed, provided separately
│
├── docs/
│   ├── ARCHITECTURE.md
│   ├── API_CONTRACT.md
│   ├── SESSION_LIFECYCLE.md
│   ├── STUBS.md
│   └── CONTRIBUTING.md
│
├── docker-compose.yml
├── .env.example
└── .gitignore                  ← repo-wide only: .env, *.log, .DS_Store
```

### Shared Types

The `shared/` package contains TypeScript type definitions used by `app/`, `feedback/`, and `client/`. Reference it as a local dependency:

```json
// app/package.json, feedback/package.json, client/package.json
{
  "dependencies": {
    "@ar-training/shared": "file:../shared"
  }
}
```

The Python `evaluation/` container defines its own dataclasses in `src/interfaces.py` — these mirror the shared TypeScript types and the JSON shapes in `docs/API_CONTRACT.md`.

### IDE Setup

**Recommended: WebStorm** opened at the repo root. WebStorm discovers all `package.json` files automatically and provides full IntelliSense across all TypeScript services including cross-service resolution of the `shared/` package. Mark `scenarios/`, `models/`, and `docs/` as excluded directories (Settings → Directories) to prevent WebStorm from indexing video files and keep search fast.

For Python, WebStorm provides basic syntax support when you configure a Python interpreter pointing at `evaluation/.venv` (Settings → Languages & Frameworks → Python Interpreter). If you find yourself spending significant time in the evaluation container, open it separately in **PyCharm** with `evaluation/` as the project root for full Python IntelliSense.

**Alternative: VS Code** at the repo root with the Pylance, ESLint, and Docker extensions handles all languages in one window.

---

## Useful Commands

```bash
# Start full stack
docker compose up

# Start with rebuilt images (after code changes)
docker compose up --build

# Scale evaluation workers
docker compose up --scale evaluation=3

# View logs for a specific container
docker compose logs -f evaluation

# Run a one-off command inside a container
docker compose run --rm evaluation python -m pytest

# Stop everything and remove containers
docker compose down

# Stop and also remove volumes (clears Ollama model cache)
docker compose down -v
```

---

## Adding a New Scenario

1. Create a directory under `scenarios/` named after your `scenario_id`
2. Add video clips as `.mp4` files
3. Create `metadata.json` following the schema in `scenarios/schema.md`
4. Verify the branching graph has no dead ends (every non-terminal clip must have conditions covering `-1.0` to `1.0`)
5. Restart the App container — scenarios are loaded at startup

---

## Implementing a Real AI Component

Each AI component has a corresponding interface in `src/interfaces/interfaces.py`. To add a real implementation:

1. Create a new file in the appropriate container's source directory (e.g. `src/evaluation/my_classifier.py`)
2. Subclass the relevant interface (`BehaviourAnalyserInterface` or `FeedbackGeneratorInterface`)
3. Implement all abstract methods
4. Register the new implementation in the container's factory function (see `STUBS.md` for the pattern)
5. Set the corresponding environment variable in `.env`

The rest of the system requires no changes.

---

## Code Style

**TypeScript (App, Feedback, Client)**
- TypeScript strict mode enabled
- Interfaces for all data transfer objects — defined once in `src/shared/types.ts` and imported by all TypeScript containers and the client
- Abstract classes for all swappable components
- No business logic in entrypoints (`main.ts`) — delegate to interface implementations

**Python (Evaluation)**
- Python 3.11+
- Type hints on all function signatures
- Dataclasses for all data transfer objects
- Abstract base classes for all swappable components
- No business logic in entrypoints (`main.py`) — delegate to interface implementations
