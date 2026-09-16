# Transcription Container

The Transcription container receives a continuous stream of raw audio from the App container and produces transcript segments in real time using [faster-whisper](https://github.com/SYSTRAN/faster-whisper). It is stateless at the container level — all per-session state is in-memory and scoped to a single container instance. Horizontal scaling is supported; the App container pins each session to a consistent instance via hash-based routing.

---

## Responsibilities

- **Audio ingestion** — accepts a persistent WebSocket connection per clip from the App container, receives `AudioChunk` messages containing base64-encoded s16le PCM at 16 kHz, and accumulates audio into a per-session buffer
- **Rolling transcription** — once the buffer exceeds a minimum threshold (~2 s), dispatches the window to the Whisper pool and emits a partial `Transcript` message back over the WebSocket; the tail of each dispatched window (`overlap_pcm`) is retained and prepended to the next buffer to avoid cutting words at window boundaries
- **Deduplication** — tracks `emitted_until` (the end time of the last emitted word) so that words from the overlap region are not re-emitted in subsequent windows
- **Finalisation** — on `POST /transcription/finalise/{session_id}`, transcribes any remaining buffered audio and emits a final `Transcript` message (`is_final: true`), which signals the App container that the clip transcript is complete
- **Buffer reset** — on `POST /transcription/reset/{session_id}`, clears the per-session PCM buffer, `overlap_pcm`, `emitted_until`, and `window_seq` counter between clips
- **Health reporting** — `GET /transcription/health` reports total and available Whisper workers and the inference device

---

## Architecture

### Classes

**`TranscriptionService`** — the orchestration layer. Owns all per-session logic: PCM accumulation, rolling window dispatch, overlap handling, deduplication, finalisation, and `Transcript` emission. Holds a `SessionStore` reference and delegates inference to the injected `TranscriptionPoolInterface`. Route handlers in `main.py` are thin — they call `TranscriptionService` methods and translate the results into HTTP responses or WebSocket messages.

**`SessionStore`** — in-memory registry of active sessions. Each entry holds the live WebSocket reference, the raw PCM accumulation buffer, the overlap PCM tail from the last dispatched window, the `emitted_until` timestamp for deduplication, a monotonically increasing `window_seq` counter, and the per-session `language` code supplied at connection time. Keyed by `session_id`. The App container pins each session to a single container instance so entries are never shared across processes.

**`WhisperPool`** — real faster-whisper implementation of `TranscriptionPoolInterface`. Maintains a fixed pool of `WhisperModel` instances (one per worker). Each `transcribe()` call acquires a free model via an `asyncio.Semaphore`, runs inference in a `ThreadPoolExecutor` (so the event loop is never blocked), and releases the model back to the pool. Accepts a per-call `language` override. Silero VAD (`vad_filter=True`) runs as a pre-pass on each audio buffer so silence is automatically skipped. If inference raises, the model instance is discarded rather than returned to the pool to prevent a corrupt model from affecting future requests.

**`StubTranscriptionPool`** — development stub. Returns a fixed Dutch placeholder string without calling Whisper. Used when `TRANSCRIPTION_POOL=stub`. See `docs/stub_guide.md`.

**`SessionEntry`** — dataclass holding per-session state: WebSocket reference, PCM bytearray buffer, `overlap_pcm` (tail of the last dispatched window, prepended to the next dispatch), `emitted_until` (float seconds — end time of the last word sent to the App, used to filter duplicates from the overlap region), `window_seq` counter, and the per-session `language` code. Created by `SessionStore.open()` on each new WebSocket connection, discarded on disconnect.

### Audio pipeline

```
App container (ClipSession)
    │  WebSocket /ws/{session_id}?language=nl  (opened once per clip)
    │  AudioChunk messages (base64 PCM) over the connection
    ▼
TranscriptionService.on_audio_chunk()
    │  decode base64 → append to pcm_buffer
    │  if buffer ≥ _MIN_BUFFER_BYTES (~2 s at 16 kHz s16le):
    ▼
TranscriptionService._transcribe_window(is_final=False)
    │  prepend overlap_pcm to snapshot → dispatch to pool
    │  pool.transcribe(pcm, language=entry.language)
    │  → TranscriptSegment with word timings
    │  filter words where word.end ≤ emitted_until  (deduplication)
    │  update emitted_until = max word end time
    │  retain tail of pcm as overlap_pcm for next window
    │  clear main buffer
    ▼
Transcript message (is_final=False) → WebSocket → ClipSession

... audio continues accumulating ...

POST /transcription/finalise/{session_id}
    ▼
TranscriptionService.finalise()
    │  prepend overlap_pcm to remaining buffer
    │  pool.transcribe(pcm, language=entry.language)
    │  filter duplicates via emitted_until
    ▼
Transcript message (is_final=True) → WebSocket → ClipSession resolves
```

Each rolling window is deduped using `emitted_until` so the App container never receives the same word twice, even though the overlap region is present in both the current and the previous dispatch. `ClipSession` on the App side concatenates all received transcript text — partial and final — into a single running string. The `is_final: true` message signals that the string is complete, not that it contains the entire transcript by itself.

---

## API

See `docs/api_contract.md` for the full wire format.

All endpoints except `/transcription/health` require `Authorization: Bearer <INTERNAL_API_KEY>`.

| Method | Path                                   | Auth     | Description                                                                                                                                                                                     |
|--------|----------------------------------------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `WS`   | `/ws/{session_id}?language={code}`     | Required | Persistent audio stream per clip. `language` is an optional ISO 639-1 query param (e.g. `nl`, `en`). Overrides the container default for this session. Accepts `AudioChunk`, emits `Transcript` |
| `POST` | `/transcription/finalise/{session_id}` | Required | Flush remaining audio and emit final `Transcript`. Returns 404 if session unknown                                                                                                               |
| `POST` | `/transcription/reset/{session_id}`    | Required | Clear PCM buffer, `overlap_pcm`, `emitted_until`, and `window_seq` between clips                                                                                                                |
| `GET`  | `/transcription/health`                | None     | Worker pool status and inference device                                                                                                                                                         |

### WebSocket message types

| Direction       | Type          | Description                                        |
|-----------------|---------------|----------------------------------------------------|
| App → Container | `audio_chunk` | Base64-encoded s16le PCM at 16 kHz                 |
| Container → App | `transcript`  | Transcribed text segment, partial or final         |

---

## Configuration

Copy `.env.example` to `.env` and set `INTERNAL_API_KEY`. All other variables have defaults.

| Variable             | Default      | Description                                                                                                                                                                                                      |
|----------------------|--------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `INTERNAL_API_KEY`   | _(required)_ | Shared secret validated on all authenticated requests. Must match the value in the App container. Generate with `openssl rand -hex 32`                                                                           |
| `TRANSCRIPTION_POOL` | `stub`       | `stub` — canned responses, no Whisper; `production` — real WhisperPool                                                                                                                                           |
| `WHISPER_MODEL`      | `base`       | faster-whisper model size: `tiny`, `base`, `small`, `medium`, `large-v3`                                                                                                                                         |
| `WHISPER_LANGUAGE`   | `nl`         | Fallback ISO 639-1 language code used when the App container does not supply a `language` query parameter on the WebSocket URL. Override per-session by passing `?language=<code>` — no container restart needed |
| `WHISPER_WORKERS`    | `4`          | Number of `WhisperModel` instances in the pool — controls transcription parallelism                                                                                                                              |
| `WHISPER_BEAM_SIZE`  | `5`          | Beam search width passed to `model.transcribe()`. Higher is more accurate but roughly proportionally slower; lower it (e.g. `1` for greedy decoding) if latency matters more than accuracy                       |
| `DEVICE`             | `cpu`        | `cpu` or `cuda`. CUDA requires the NVIDIA Container Toolkit                                                                                                                                                      |
| `PORT`               | `8003`       | Internal listen port                                                                                                                                                                                             |

### Model size trade-offs

| Model      | Speed (CPU) | Accuracy | Recommended for                         |
|------------|-------------|----------|-----------------------------------------|
| `tiny`     | Fastest     | Low      | Rapid prototyping only                  |
| `base`     | Fast        | Good     | Default — development and MBO classroom |
| `small`    | Moderate    | Better   | Higher accuracy requirement             |
| `medium`   | Slow        | High     | GPU deployment                          |
| `large-v3` | Slowest     | Highest  | GPU deployment, best quality            |

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

| File                                    | Coverage                                                                                                                                                                                       |
|-----------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `tests/test_session_store.py`           | Open/close/reset lifecycle, PCM accumulation, sequence counter, isolation between sessions                                                                                                     |
| `tests/test_stub_transcription_pool.py` | Stub contract: fixed text, full confidence, pool properties                                                                                                                                    |
| `tests/test_transcription_service.py`   | PCM buffering, rolling window trigger and dispatch, overlap prepend, `emitted_until` deduplication, Whisper error handling, finalisation, empty-buffer path, window_seq, send failure handling |
| `tests/test_routes.py`                  | Auth enforcement on all endpoints, HTTP response shapes, WebSocket lifecycle, message routing                                                                                                  |

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