"""
WhisperPool — real faster-whisper implementation of TranscriptionPoolInterface.

Maintains a fixed pool of WhisperModel instances (one per worker). Each
transcribe() call acquires a free model, runs inference in a thread executor
(to avoid blocking the asyncio event loop), then releases the model back.

Thread safety: WhisperModel instances are not thread-safe. The pool enforces
exclusive access per model via an asyncio.Semaphore + queue.Queue pair.
"""

from __future__ import annotations

import asyncio
import logging
import queue
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from faster_whisper import WhisperModel

from config import TranscriptionConfig
from interfaces import TranscriptionPoolInterface, TranscriptSegment

logger = logging.getLogger(__name__)


class WhisperPool(TranscriptionPoolInterface):
    """
    Pool of faster-whisper WhisperModel instances.

    Constructor blocks while all models load — call during app startup
    (inside the FastAPI lifespan) so the container fails fast on bad config
    rather than on the first request.
    """

    def __init__(self, cfg: TranscriptionConfig) -> None:
        self._worker_count = cfg.whisper_workers
        self._language     = cfg.whisper_language
        self._device       = cfg.device

        # Thread pool sized to the number of Whisper workers so each model
        # can run in its own thread without contention.
        self._executor = ThreadPoolExecutor(
            max_workers = cfg.whisper_workers,
            thread_name_prefix = "whisper-worker",
        )

        # Load all models upfront. This is intentionally synchronous and
        # blocking — model load time is acceptable at startup.
        logger.info(
            "Loading %d WhisperModel instance(s): model=%s device=%s language=%s",
            cfg.whisper_workers, cfg.whisper_model, cfg.device, cfg.whisper_language,
        )
        self._models: queue.Queue[WhisperModel] = queue.Queue()
        for _ in range(cfg.whisper_workers):
            model = WhisperModel(
                cfg.whisper_model,
                device          = cfg.device,
                compute_type    = "int8" if cfg.device == "cpu" else "float16",
            )
            self._models.put(model)

        # Semaphore limits concurrent transcriptions to the pool size.
        # Callers block here rather than queueing up on the model queue.
        self._semaphore = asyncio.Semaphore(cfg.whisper_workers)

        # Available-worker counter for health reporting.
        # Decremented on acquire, incremented on release.
        self._available = cfg.whisper_workers

        logger.info("WhisperPool ready — %d worker(s)", cfg.whisper_workers)

    # ── TranscriptionPoolInterface ────────────────────────────────────────────

    async def transcribe(
        self,
        pcm:         bytes,
        sample_rate: int,
        session_id:  str,
    ) -> TranscriptSegment:
        """
        Transcribe a buffer of s16le PCM audio.

        Converts PCM → float32 numpy array, acquires a free WhisperModel,
        runs transcription in a thread executor, and returns the result.

        If the audio is entirely silence (VAD filters everything), returns an
        empty TranscriptSegment rather than raising.
        """
        audio = _pcm_to_float32(pcm)

        async with self._semaphore:
            self._available -= 1
            model = self._models.get()
            try:
                loop   = asyncio.get_running_loop()
                result = await loop.run_in_executor(
                    self._executor,
                    _run_transcription,
                    model,
                    audio,
                    self._language,
                )
            finally:
                self._models.put(model)
                self._available += 1

        logger.debug(
            "transcribed session=%s text=%r confidence=%.2f",
            session_id, result.text, result.confidence,
        )
        return result

    @property
    def worker_count(self) -> int:
        return self._worker_count

    @property
    def available_workers(self) -> int:
        return max(0, self._available)

    @property
    def device(self) -> str:
        return self._device


# ── Thread-local helpers (run inside executor) ────────────────────────────────

def _pcm_to_float32(pcm: bytes) -> np.ndarray:
    """
    Convert raw s16le PCM bytes to a normalised float32 numpy array.
    faster-whisper expects float32 in the range [-1.0, 1.0].
    """
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def _run_transcription(
    model:    WhisperModel,
    audio:    np.ndarray,
    language: str,
) -> TranscriptSegment:
    """
    Synchronous transcription call — runs inside a thread executor.

    Materialises the segment generator fully before returning so the model
    is safe to release back to the pool. The generator is tied to the model's
    internal state and must not outlive this function.

    VAD is enabled via vad_filter=True so silence is skipped automatically
    without manual buffer windowing in the service layer.
    """
    segments_gen, info = model.transcribe(
        audio,
        language         = language,
        vad_filter       = True,
        beam_size        = 5,
    )

    # Materialise the lazy generator completely inside this thread.
    segments = list(segments_gen)

    if not segments:
        return TranscriptSegment(text="", confidence=0.0)

    text = " ".join(s.text.strip() for s in segments if s.text.strip())

    # faster-whisper provides per-segment avg_logprob. Convert to a 0–1
    # confidence proxy: logprob of 0 → 1.0, logprob of -1 → ~0.37.
    avg_logprob  = sum(s.avg_logprob for s in segments) / len(segments)
    confidence   = float(min(1.0, max(0.0, 1.0 + avg_logprob)))

    return TranscriptSegment(text=text, confidence=confidence)