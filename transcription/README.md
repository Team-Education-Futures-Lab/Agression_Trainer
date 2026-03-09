# Transcription Container

The Transcription container receives a continuous stream of raw audio from the App container and produces transcript segments in real time using [faster-whisper](https://github.com/SYSTRAN/faster-whisper). It is stateless at the container level — all per-session state is in-memory and scoped to a single container instance. Horizontal scaling is supported; the App container pins each session to a consistent instance via hash-based routing.

---

## Responsibilities

- **Audio ingestion** — accepts a persistent WebSocket connection per clip from the App container, receives `AudioChunk` messages containing base64-encoded s16le PCM at 16 kHz, and accumulates audio into a per-session buffer
- **Rolling transcription** — once the buffer exceeds a minimum threshold (~2 s), dispatches a window to the Whisper pool and streams a partial `Transcript` message back over the WebSocket
- **Finalisation** — on `POST /transcription/finalise/{session_id}`, transcribes any remaining buffered audio and emits a final `Transcript` message (`is_final: true`), which signals the App container that the clip transcript is complete
- **Buffer reset** — on `POST /transcription/reset/{session_id}`, clears the per-session PCM buffer between clips
- **Health reporting** — `GET /transcription/health` reports total and available Whisper workers and the inference device

---

## Architecture

### Classes

**`TranscriptionService`** — the orchestration layer. Owns all per-session logic: PCM accumulation, rolling window dispatch, finalisation, and `Transcript` emission. Holds a `SessionStore` reference and delegates inference to the injected `TranscriptionPoolInterface`. Route handlers in `main.py` are thin — they call `TranscriptionService` methods and translate the results into HTTP responses or WebSocket messages.

**`SessionStore`** — in-memory registry of active sessions. Each entry holds the live WebSocket reference, the raw PCM accumulation buffer, and a monotonically increasing `window_seq` counter. Keyed by `session_id`. The App container pins each session to a single container instance so entries are never shared across processes.

**`WhisperPool`** — real faster-whisper implementation of `TranscriptionPoolInterface`. Maintains a fixed pool of `WhisperModel` instances (one per worker). Each `transcribe()` call acquires a free model via an `asyncio.Semaphore`, runs inference in a `ThreadPoolExecutor` (so the event loop is never blocked), and releases the model back to the pool. Silero VAD (`vad_filter=True`) runs as a pre-pass on each audio buffer so silence is automatically skipped without manual windowing. All models load at startup — the container fails fast if the model name or device is misconfigured.

**`StubTranscriptionPool`** — development stub. Returns a fixed Dutch placeholder string without calling Whisper. Used when `TRANSCRIPTION_POOL=stub`. See `docs/stub_guide.md`.

**`SessionEntry`** — dataclass holding per-session state: WebSocket reference, PCM bytearray buffer, and `window_seq` counter. Created by `SessionStore.open()` on each new WebSocket connection, discarded on disconnect.

### Audio pipeline

```
App container (ClipSession)
    │  AudioChunk messages (base64 PCM) over WebSocket
    ▼
TranscriptionService.on_audio_chunk()
    │  decode base64 → append to pcm_buffer
    │  if buffer ≥ _MIN_BUFFER_BYTES (2s):
    ▼
TranscriptionService._transcribe_window(is_final=False)
    │  snapshot + clear buffer
    │  pool.transcribe(pcm) → TranscriptSegment
    ▼
Transcript message (is_final=False) → WebSocket → ClipSession

... audio continues accumulating ...

POST /transcription/finalise/{session_id}
    ▼
TranscriptionService.finalise()
    │  snapshot + clear buffer
    │  pool.transcribe(pcm) → TranscriptSegment  (or empty if buffer empty)
    ▼
Transcript message (is_final=True) → WebSocket → ClipSession resolves
```

Each rolling window covers a clean, non-overlapping segment of audio. `ClipSession` on the App side concatenates all received transcript text — partial and final — into a single running string. The `is_final: true` message signals that the string is complete, not that it contains the entire transcript by itself.

---

## API

See `docs/api_contract.md` for the full wire format.

All endpoints except `/transcription/health` require `Authorization: Bearer <INTERNAL_API_KEY>`.

| Method | Path                                    | Auth     | Description                                                               |
|--------|-----------------------------------------|----------|---------------------------------------------------------------------------|
| `WS`   | `/ws/{session_id}`                      | Required | Persistent audio stream per clip. Accepts `AudioChunk`, emits `Transcript`|
| `POST` | `/transcription/finalise/{session_id}`  | Required | Flush remaining audio and emit final `Transcript`. Returns 404 if session unknown |
| `POST` | `/transcription/reset/{session_id}`     | Required | Clear PCM buffer between clips                                            |
| `GET`  | `/transcription/health`                 | None     | Worker pool status and inference device                                   |

### WebSocket message types

| Direction       | Type          | Description                                        |
|-----------------|---------------|----------------------------------------------------|
| App → Container | `audio_chunk` | Base64-encoded s16le PCM at 16 kHz                 |
| Container → App | `transcript`  | Transcribed text segment, partial or final         |

---

## Configuration

Copy `.env.example` to `.env` and set `INTERNAL_API_KEY`. All other variables have defaults.

| Variable             | Default        | Description                                                                                         |
|----------------------|----------------|-----------------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_   | Shared secret validated on all authenticated requests. Must match the value in the App container. Generate with `openssl rand -hex 32` |
| `TRANSCRIPTION_POOL` | `stub`         | `stub` — canned responses, no Whisper; `production` — real WhisperPool                             |
| `WHISPER_MODEL`      | `base`         | faster-whisper model size: `tiny`, `base`, `small`, `medium`, `large-v3`                           |
| `WHISPER_LANGUAGE`   | `nl`           | ISO 639-1 language code passed to Whisper                                                           |
| `WHISPER_WORKERS`    | `4`            | Number of `WhisperModel` instances in the pool — controls transcription parallelism                 |
| `DEVICE`             | `cpu`          | `cpu` or `cuda`. CUDA requires the NVIDIA Container Toolkit                                         |
| `PORT`               | `8003`         | Internal listen port                                                                                |

### Model size trade-offs

| Model      | Speed (CPU) | Accuracy | Recommended for              |
|------------|-------------|----------|------------------------------|
| `tiny`     | Fastest     | Low      | Rapid prototyping only       |
| `base`     | Fast        | Good     | Default — development and MBO classroom |
| `small`    | Moderate    | Better   | Higher accuracy requirement  |
| `medium`   | Slow        | High     | GPU deployment               |
| `large-v3` | Slowest     | Highest  | GPU deployment, best quality |

For CPU-only classroom deployments `base` with `WHISPER_WORKERS=4` is the recommended starting point. Each worker occupies approximately 500 MB of RAM at `base` size.

---

## Development

```bash
# Create and activate virtual environment
python -m venv .venv
.venv\Scripts\activate       # Windows
source .venv/bin/activate    # macOS / Linux

# Install dependencies
pip install -r requirements.txt

# Run tests
pytest

# Run tests with verbose output
pytest -v

# Run a specific test file
pytest tests/test_transcription_service.py

# Run a specific test class
pytest tests/test_transcription_service.py::TestFinalise
```

Set `TRANSCRIPTION_POOL=stub` (the default) during development so tests and local runs do not require a downloaded Whisper model.

---

## Testing

Tests live in `tests/` and use pytest with pytest-asyncio. Run the full suite with `pytest`.

| File                                  | Coverage                                                                                         |
|---------------------------------------|--------------------------------------------------------------------------------------------------|
| `tests/test_session_store.py`         | Open/close/reset lifecycle, PCM accumulation, sequence counter, isolation between sessions       |
| `tests/test_stub_transcription_pool.py` | Stub contract: fixed text, full confidence, pool properties                                    |
| `tests/test_transcription_service.py` | PCM buffering, rolling window trigger and dispatch, finalisation, empty-buffer path, window_seq, send failure handling |
| `tests/test_routes.py`                | Auth enforcement on all endpoints, HTTP response shapes, WebSocket lifecycle, message routing    |

---

## Building with Docker

The Dockerfile expects the repo root as its build context. Always build via Docker Compose from the repo root:

```bash
docker compose up --build
```

To run multiple Transcription workers on the same server:

```bash
docker compose up --scale transcription=3
```

The App container automatically distributes sessions across instances via session-pinned hash routing — no configuration changes are needed.