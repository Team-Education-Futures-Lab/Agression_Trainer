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
from interfaces import TranscriptionPoolInterface, TranscriptSegment, WordTiming

logger = logging.getLogger(__name__)


class TranscriptionError(Exception):
    """
    Raised by WhisperPool.transcribe() when inference fails.

    The model instance that raised is discarded from the pool rather than
    returned, preventing a potentially corrupt model from affecting future
    requests. The pool degrades gracefully: worker_count decrements by one.
    """


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
        self._beam_size    = cfg.whisper_beam_size

        self._executor = ThreadPoolExecutor(
            max_workers        = cfg.whisper_workers,
            thread_name_prefix = "whisper-worker",
        )

        logger.info(
            "Loading %d WhisperModel instance(s): model=%s device=%s language=%s",
            cfg.whisper_workers, cfg.whisper_model, cfg.device, cfg.whisper_language,
        )
        self._models: queue.Queue[WhisperModel] = queue.Queue()
        for _ in range(cfg.whisper_workers):
            model = WhisperModel(
                cfg.whisper_model,
                device       = cfg.device,
                compute_type = "int8" if cfg.device == "cpu" else "float16",
            )
            self._models.put(model)

        self._semaphore = asyncio.Semaphore(cfg.whisper_workers)
        self._available = cfg.whisper_workers

        logger.info("WhisperPool ready — %d worker(s)", cfg.whisper_workers)

    # ── TranscriptionPoolInterface ────────────────────────────────────────────

    async def transcribe(
        self,
        pcm:         bytes,
        sample_rate: int,
        session_id:  str,
        language:    str = "",
    ) -> TranscriptSegment:
        """
        Transcribe a buffer of s16le PCM audio.

        The buffer is expected to be overlap_pcm + new_pcm, already
        concatenated by the service layer. All words are returned with
        timestamps relative to the start of this buffer (t=0). No filtering
        is applied — the service layer handles duplicate elimination via
        emitted_until.

        On inference failure the model instance is discarded from the pool
        and TranscriptionError is raised.
        """
        audio              = _pcm_to_float32(pcm)
        effective_language = language or self._language

        async with self._semaphore:
            self._available -= 1
            model   = self._models.get()
            discard = False
            try:
                loop   = asyncio.get_running_loop()
                result = await loop.run_in_executor(
                    self._executor,
                    _run_transcription,
                    model,
                    audio,
                    effective_language,
                    self._beam_size,
                )
            except Exception as exc:
                discard = True
                logger.critical(
                    "Whisper inference failed for session=%s — discarding model instance: %s",
                    session_id, exc,
                )
                raise TranscriptionError(str(exc)) from exc
            finally:
                if discard:
                    self._worker_count -= 1
                    logger.warning(
                        "Worker count reduced to %d after model discard",
                        self._worker_count,
                    )
                else:
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
    """Convert raw s16le PCM bytes to a normalised float32 numpy array."""
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def _run_transcription(
    model:      WhisperModel,
    audio:      np.ndarray,
    language:   str,
    beam_size:  int,
) -> TranscriptSegment:
    """
    Synchronous transcription call — runs inside a thread executor.

    Requests word-level timestamps from faster-whisper and returns all
    recognised words without any filtering. The buffer passed in is
    overlap_pcm + new_pcm; all word timestamps are relative to t=0 of
    this combined buffer.

    The service layer uses emitted_until to skip words that fall in the
    overlap region (already emitted in a previous window).

    Any exception raised here propagates back to WhisperPool.transcribe(),
    which catches it, discards the model instance, and re-raises as
    TranscriptionError.
    """
    segments_gen, _info = model.transcribe(
        audio,
        language        = language,
        vad_filter      = True,
        beam_size       = beam_size,
        word_timestamps = True,
    )
    segments = list(segments_gen)

    if not segments:
        return TranscriptSegment(text="", confidence=0.0)

    words: list[WordTiming] = []
    for seg in segments:
        for w in (seg.words or []):
            words.append(WordTiming(
                word  = w.word,
                start = w.start,
                end   = w.end,
            ))

    if not words:
        return TranscriptSegment(text="", confidence=0.0)

    text = " ".join(w.word.strip() for w in words if w.word.strip())

    avg_logprob = sum(s.avg_logprob for s in segments) / len(segments)
    confidence  = float(min(1.0, max(0.0, 1.0 + avg_logprob)))

    return TranscriptSegment(
        text       = text,
        confidence = confidence,
        words      = words,
    )