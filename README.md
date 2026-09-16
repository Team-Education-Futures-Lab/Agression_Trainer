# Agression Trainer — AR De-escalation Training Platform

A web-based de-escalation training platform for classroom use (MBO context). Students
respond to branching video scenarios while the system captures their behaviour,
transcribes their speech, scores their response, and generates coaching feedback at
the end of each session.

The interaction loop per clip: **watch a clip → respond on camera → the response is
scored → the next clip is chosen from that score → repeat until a terminal clip →
LLM debrief.**

---

## Architecture

Six containers, communicating only over HTTP and WebSocket. Full detail in
[`docs/architecture.md`](docs/architecture.md).

| Container       | Language           | Role                                                                                   |
|-----------------|--------------------|---------------------------------------------------------------------------------------|
| `client`        | TypeScript / React | Webcam + mic capture, MediaPipe landmarks, Meyda MFCCs. Served by nginx in production. |
| `app`           | TypeScript / Node  | Session lifecycle, capacity/queue, WebSocket hub, routes data between client and AI services, auth (JWT + SQLite). |
| `transcription` | Python / FastAPI   | `faster-whisper` + VAD, continuous per-clip audio transcription. GPU-optional, scalable. |
| `evaluation`    | Python / FastAPI   | Deterministic signal-extraction + rubric scorer → `escalation_score`. GPU-optional, scalable. |
| `feedback`      | TypeScript / Node  | Formats the prompt and streams an end-of-session debrief from Ollama.                   |
| `ollama`        | —                  | Local LLM inference, persisted model volume.                                            |

Scoring is **not** a trained classifier: three signal-extraction stages (audio emotion,
landmark features, transcript features) feed a deterministic weighted scorer driven by
the rubric in each clip's `metadata.json`. The interface matches what a trained model
would implement, so it can be swapped later without touching the rest of the system.

Every AI component sits behind an interface with a **stub** implementation (default) so
the full pipeline runs end-to-end with no models or Ollama. See
[`docs/stub_guide.md`](docs/stub_guide.md).

---

## Repository layout

```
app/            App container (session/auth/coordinator)
transcription/  Whisper transcription container
evaluation/     Behaviour analyser container (signal extraction + scorer)
feedback/       Ollama debrief container
client/         Browser client — 4 entry points: / (debug), /demo.html (student), /admin (scenario builder), /devtools.html (dev only)
shared/         Shared TypeScript DTO types (file: dependency for app/feedback/client)
scenarios/      One directory per scenario: metadata.json + .mp4 clips (video via Git LFS)
docs/           Architecture, API contract, schemas, lifecycle, auth, dev setup
models/         Ollama model storage + ML model files (bind-mounted, not committed)
data/           auth.db (SQLite), created on first startup, not committed
docker-compose.yml        Local / single-server deployment
dokploy-compose.yml       Dokploy deployment variant
```

---

## Quick start (local, all stubs)

Requires Docker (and the NVIDIA Container Toolkit only if using GPU). No local Node or
Python needed.

### 1. Create all four `.env` files

Each service is wired to its own `.env` via `env_file:` in `docker-compose.yml` — a
missing file aborts `docker compose up`.

```bash
cp app/.env.example           app/.env
cp transcription/.env.example transcription/.env
cp evaluation/.env.example    evaluation/.env
cp feedback/.env.example      feedback/.env
```

### 2. Set the secrets

- **`INTERNAL_API_KEY`** — generate once with `openssl rand -hex 32` and paste the
  **same value** into all four `.env` files. A mismatch makes every App→AI-service
  call return `401`.
- **`JWT_SECRET`** (in `app/.env`) — a separate `openssl rand -hex 32`. The App will
  not start without it.
- **`BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`** (in `app/.env`,
  commented out by default) — set these on the first run to log in at `/admin` or
  create admin sessions. Remove them again once the account exists.

The example files already set `BEHAVIOUR_ANALYSER=stub`, `FEEDBACK_GENERATOR=stub`,
and `TRANSCRIPTION_POOL=stub`, so no models and no Ollama are needed.

### 3. Fetch the scenario videos (Git LFS)

Clips are stored in Git LFS. Without them the App still boots, but the browser gets
`404` on the `<video>` element and the demo flow cannot complete.

```bash
git lfs install
git lfs pull
```

### 4. Start the stack

```bash
docker compose up --build app client transcription evaluation feedback
```

- Client: `http://localhost:3000`  (student flow at `/demo.html`, scenario builder at `/admin`)

> Only `/admin` has a pretty-URL rewrite in `client/nginx.conf`. `/demo` and
> `/devtools` are served under their real filenames (`/demo.html`,
> `/devtools.html`) — the extension-less URL falls through to the SPA
> catch-all and serves the debug harness (`/`) instead.
- App API: `http://localhost:3001`

> The client image bakes in `http://localhost:3001` / `ws://localhost:3001` as the App
> URL. Accessing the stack from another host means rebuilding the client with
> `--build-arg VITE_APP_HTTP_URL=… --build-arg VITE_APP_WS_URL=…` (or using
> `dokploy-compose.yml`).

### Full stack with real feedback

```bash
docker compose up -d ollama
docker compose exec ollama ollama pull llama3.2
docker compose up --build
```

Switch individual services to real implementations via their own `.env`:
`BEHAVIOUR_ANALYSER=production`, `FEEDBACK_GENERATOR=production`,
`TRANSCRIPTION_POOL=production`. See [`docs/dev_setup.md`](docs/dev_setup.md) for the
complete environment-variable reference.

---

## Scaling

The App container reads service URLs from env and pins each session to an instance by
hash — no proxy container.

| Goal                    | How                                                                        |
|-------------------------|---------------------------------------------------------------------------|
| Single server           | `docker compose up`                                                        |
| More transcription/eval | `docker compose up --scale transcription=N --scale evaluation=N`           |
| Offload feedback/Ollama | Point `FEEDBACK_URL` at a second (GPU) host                                 |
| Multi-host AI services  | Set `EVALUATION_URL` / `TRANSCRIPTION_URL` to comma-separated URL lists     |

---

## Tests

```bash
docker compose run --rm app npm test
docker compose run --rm feedback npm test
docker compose run --rm transcription python -m pytest
docker compose run --rm evaluation python -m pytest
```

---

## Key documentation

| Document | Contents |
|----------|----------|
| [`docs/architecture.md`](docs/architecture.md)             | System diagram, data flow, evaluation pipeline, data types |
| [`docs/api_contract.md`](docs/api_contract.md)             | Client ↔ App HTTP + WebSocket wire format |
| [`docs/admin_and_tooling_api.md`](docs/admin_and_tooling_api.md) | Operator endpoints + inter-container APIs |
| [`docs/session_lifecycle.md`](docs/session_lifecycle.md)   | Session state machine |
| [`docs/scenario_schema.md`](docs/scenario_schema.md)       | `metadata.json` schema + rubric signal vocabulary |
| [`docs/auth.md`](docs/auth.md)                             | User accounts, JWTs, admin sessions |
| [`docs/dev_setup.md`](docs/dev_setup.md)                   | Full setup + every environment variable |
| [`docs/stub_guide.md`](docs/stub_guide.md)                 | Stub behaviour and how to swap in real implementations |
| [`docs/optional_dokploy_deployment.md`](docs/optional_dokploy_deployment.md) | What Dokploy adds for production deployment (optional) |
```
