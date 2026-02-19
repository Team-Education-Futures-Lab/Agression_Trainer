# Contributing & Developer Setup

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

During development you almost certainly want stub AI implementations so you don't need a trained classifier or a running Ollama instance. Set the following in `.env`:

```bash
BEHAVIOUR_ANALYSER=stub
FEEDBACK_GENERATOR=stub
```

Then start only the containers you need:

```bash
# Run without the Ollama sidecar (stub doesn't need it)
docker compose up app proxy evaluation feedback
```

See `STUBS.md` for details on stub behaviour.

---

## Environment Variables

All configuration lives in `.env`. The full reference is in `.env.example`. The most commonly changed variables during development:

| Variable | Default | Description |
|---|---|---|
| `BEHAVIOUR_ANALYSER` | `stub` | `stub` or `production` |
| `FEEDBACK_GENERATOR` | `stub` | `stub` or `production` |
| `WHISPER_MODEL` | `base` | `tiny`, `base`, `small`, `medium`, `large-v3` |
| `WHISPER_LANGUAGE` | `nl` | ISO 639-1 language code |
| `WHISPER_WORKERS` | `4` | Whisper instances in the pool |
| `DEVICE` | `cpu` | `cpu` or `cuda` |
| `FEEDBACK_MODEL` | `llama3.2` | Ollama model name |
| `OLLAMA_HOST` | `http://ollama:11434` | Override to use external Ollama |

---

## Project Structure

```
ar-training/
├── docker/
│   ├── app.Dockerfile
│   ├── evaluation.Dockerfile
│   ├── feedback.Dockerfile
│   └── proxy.Dockerfile
├── scenarios/
│   └── scenario_01/
│       ├── metadata.json
│       └── *.mp4
├── models/
│   └── classifier.pkl          ← not committed, provided separately
├── config/
│   └── settings.py
├── src/
│   ├── interfaces/             ← abstract base classes (shared across containers)
│   │   ├── __init__.py
│   │   └── interfaces.py
│   ├── stubs/                  ← stub implementations for development
│   │   ├── behaviour_analyser.py
│   │   └── feedback_generator.py
│   ├── app/                    ← App container source
│   │   ├── session_manager.py
│   │   ├── coordinator.py
│   │   └── main.py
│   ├── evaluation/             ← Evaluation container source
│   │   ├── transcription.py
│   │   ├── behaviour_analyser.py
│   │   └── main.py
│   ├── feedback/               ← Feedback container source
│   │   ├── feedback_generator.py
│   │   └── main.py
│   └── proxy/                  ← Proxy container source
│       └── main.py
├── docker-compose.yml
├── .env.example
├── ARCHITECTURE.md
├── API_CONTRACT.md
├── SESSION_LIFECYCLE.md
└── STUBS.md
```

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

- Python 3.11+
- Type hints on all function signatures
- Dataclasses for all data transfer objects
- Abstract base classes for all swappable components
- No business logic in container entrypoints (`main.py`) — delegate to interface implementations
