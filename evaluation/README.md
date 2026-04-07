# Evaluation Container

Stateless Python/FastAPI service that analyses a student's response to a scenario clip and returns a `BehaviourResult`. Called exactly once per clip by the App container.

---

## Responsibility

Receives a complete `AnalysisWindow` at the end of each clip — all MediaPipe landmark frames, pre-computed MFCCs, the full Whisper transcript, session-level word timings, and clip metadata — and returns a `BehaviourResult` containing:

- `escalation_score` (−1.0 to 1.0) — drives clip branching in the App container
- `dominant_emotion` — e.g. `"calm"`, `"anxious"`, `"frustrated"`, `"neutral"`, `"distressed"`
- `confidence` (0.0 to 1.0)
- `signal_summary` — breakdown of vocal tension, speech pace, gesture activity, open gesture ratio, head nod frequency, facing ratio, silence ratio, lexical markers, response tone, and notable signals

No per-session state is held. Every request is self-contained.

For **admin sessions**, the App container adds `X-Debug: true` to the request. When this header is present, the response includes an additional `debug` field with `analyser_id` and implementation-specific intermediate stage data. Non-admin sessions receive the standard response with no debug field — the container bears no overhead of assembling debug output for sessions that will not use it.

---

## Endpoints

| Method | Path                           | Auth | Description                                                                          |
|--------|--------------------------------|------|--------------------------------------------------------------------------------------|
| `POST` | `/evaluate/analyse`            | ✅    | Analyse a clip window, return a `BehaviourResult`                                    |
| `POST` | `/evaluate/reset/{session_id}` | ✅    | No-op reset for API symmetry; always returns 200                                     |
| `GET`  | `/evaluate/health`             | ❌    | Reports status and inference device                                                  |
| `GET`  | `/evaluate/debug/config`       | ✅    | Returns active signal thresholds and lexical phrase lists (production analyser only) |

All authenticated endpoints require `Authorization: Bearer <INTERNAL_API_KEY>`. See `docs/admin_and_tooling_api.md` for full request/response shapes including the debug response field.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable             | Default                                                        | Description                                                                                           |
|----------------------|----------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_                                                   | Shared secret — must match `app/.env` and all other containers. Generate with `openssl rand -hex 32`. |
| `BEHAVIOUR_ANALYSER` | `stub`                                                         | `stub` — deterministic results for development; `production` — real multimodal classifier.            |
| `DEVICE`             | `cpu`                                                          | `cpu` or `cuda`. CUDA requires the NVIDIA Container Toolkit.                                          |
| `EMOTION_MODEL`      | `audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim`        | HuggingFace model ID for the audio emotion classifier (production only).                              |
| `SENTIMENT_MODEL`    | `cardiffnlp/twitter-xlm-roberta-base-sentiment`                | HuggingFace model ID for the text sentiment classifier (production only).                             |
| `EVALUATION_CONFIG`  | `evaluation_config.toml` (next to `.env`)                      | Path to the tuning config file. Override to use a different location.                                 |
| `PORT`               | `8001`                                                         | Internal listen port.                                                                                 |

---

## Tuning configuration

Signal thresholds and Dutch lexical phrase lists are defined in `evaluation_config.toml`, not in code. This file is intended for non-technical tuning by pedagogy coordinators — no Python knowledge is needed. The container refuses to start if any required value is missing or out of range.

The active configuration can be inspected at runtime via `GET /evaluate/debug/config` (requires `INTERNAL_API_KEY`). In a multi-instance deployment, query each instance separately to confirm they are all running identical configuration.

---

## Running

**Via Docker (from repo root):**
```bash
docker compose up evaluation
```

**Locally:**
```bash
cd evaluation
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env        # then set INTERNAL_API_KEY
python src/main.py
```

---

## Testing

```bash
# Via Docker (from repo root)
docker compose run --rm evaluation python -m pytest

# Locally (from evaluation/ with venv active)
pytest -v
```

Tests mock out ML models entirely — no running model or other container needed. Stage B (landmark features) and the scorer are tested with no model mocking because they are pure signal processing. Stages A and C mock the HuggingFace model calls. The full `analyse()` pipeline is exercised end-to-end via `TestAnalyseIntegration` with all model calls replaced by mocks.

---

## Stub vs Production

The active implementation is selected via the `BEHAVIOUR_ANALYSER` environment variable.

| Value            | Class                   | Behaviour                                                                                                          |
|------------------|-------------------------|--------------------------------------------------------------------------------------------------------------------|
| `stub` (default) | `StubBehaviourAnalyser` | Returns deterministic results based on rubric weights; safe for development and CI.                                |
| `production`     | `BehaviourAnalyser`     | Full four-stage pipeline: audio emotion extraction, landmark feature extraction, transcript features, and scoring. |

The stub returns `escalation_score: 0.4` when the clip's escalation rubric outweighs its de-escalation rubric (or when challenging `notable_features` are present and both rubrics are empty), and `−0.2` otherwise. Scores are clamped to the clip's `score_range`. See `docs/stub_guide.md` for the full spec.

The production analyser loads both ML models at startup — the container will fail fast if either model cannot be downloaded. All model inference runs in a `ThreadPoolExecutor` to avoid blocking the asyncio event loop.

---

## Production pipeline

The production `BehaviourAnalyser` runs four stages concurrently where possible:

**Stage A — Audio emotion extraction:** Reconstructs approximate audio from MFCCs via inverse Griffin-Lim, runs the dimensional emotion model (arousal, valence), and computes `vocal_tension` from arousal and MFCC energy variance.

**Stage B — Landmark feature extraction:** Deterministic signal processing on MediaPipe face mesh and hand landmark arrays. Computes gesture activity, open gesture ratio, head nod frequency, and facing ratio. No model required.

**Stage C — Transcript feature extraction:** Computes silence ratio and speech pace from word timings, matches Dutch de-escalation phrases against a configurable phrase list, and classifies response tone via the multilingual sentiment model.

**Scorer:** Maps the computed signals to rubric entries from the clip metadata, applies `rubric` or `threshold` mode scoring, applies any `critical_failures` penalty, and clamps the result to `score_range`.

Stages A, B, and C run concurrently via `asyncio.gather`; the scorer runs once all three complete.

To add an alternative implementation: subclass `BehaviourAnalyserInterface`, set `analyser_id` as a class attribute, implement `analyse(window, *, collect_debug=False)` returning `(BehaviourResult, stages_dict | None)`, and register it in the `_make_analyser` factory in `src/main.py`. No other code needs to change.