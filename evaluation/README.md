# Evaluation Container

Stateless Python/FastAPI service that analyses a student's response to a scenario clip and returns a `BehaviourResult`. Called exactly once per clip by the App container.

---

## Responsibility

Receives a complete `AnalysisWindow` at the end of each clip — all MediaPipe landmark frames, pre-computed MFCCs, the full Whisper transcript, and clip metadata — and returns a `BehaviourResult` containing:

- `escalation_score` (−1.0 to 1.0) — drives clip branching in the App container
- `dominant_emotion` — e.g. `"calm"`, `"anxious"`
- `confidence` (0.0 to 1.0)
- `signal_summary` — breakdown of voice tension, speech pace, hand velocity, gaze stability, and open palm ratio

No per-session state is held. Every request is self-contained.

---

## Endpoints

| Method | Path                           | Auth | Description                                       |
|--------|--------------------------------|------|---------------------------------------------------|
| `POST` | `/evaluate/analyse`            | ✅    | Analyse a clip window, return a `BehaviourResult` |
| `POST` | `/evaluate/reset/{session_id}` | ✅    | No-op reset for API symmetry; always returns 200  |
| `GET`  | `/evaluate/health`             | ❌    | Reports status and inference device               |

All authenticated endpoints require `Authorization: Bearer <INTERNAL_API_KEY>`. See `docs/api_contract.md` for full request/response shapes.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable             | Default      | Description                                                                                           |
|----------------------|--------------|-------------------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_ | Shared secret — must match `app/.env` and all other containers. Generate with `openssl rand -hex 32`. |
| `BEHAVIOUR_ANALYSER` | `stub`       | `stub` — hardcoded results for development; `production` — real classifier (not yet implemented).     |
| `DEVICE`             | `cpu`        | `cpu` or `cuda`. CUDA requires the NVIDIA Container Toolkit.                                          |
| `PORT`               | `8001`       | Internal listen port.                                                                                 |

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

Tests mock out the analyser entirely — no running model or other container needed.

---

## Stub vs Production

The active implementation is selected via the `BEHAVIOUR_ANALYSER` environment variable.

| Value            | Class                         | Behaviour                                                                                         |
|------------------|-------------------------------|---------------------------------------------------------------------------------------------------|
| `stub` (default) | `StubBehaviourAnalyser`       | Returns deterministic hardcoded results based on `notable_features`. Safe for development and CI. |
| `production`     | `ProductionBehaviourAnalyser` | Real multimodal classifier — not yet implemented.                                                 |

The stub returns `escalation_score: 0.4` when the clip's `notable_features` include `raised_voice`, `aggressive_posture`, or `pointing_gesture`, and `−0.2` otherwise. See `docs/stub_guide.md` for the full spec.

To add the real classifier: subclass `BehaviourAnalyserInterface` in `src/models/`, implement `analyse()`, and register it in the `_make_analyser` factory in `src/main.py`. No other code needs to change.