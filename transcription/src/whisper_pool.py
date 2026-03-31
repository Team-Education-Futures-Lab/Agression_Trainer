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
        pcm:            bytes,
        sample_rate:    int,
        session_id:     str,
        initial_prompt: str   = "",
        language:       str   = "",
        cutoff_time:    float = 0.0,
    ) -> TranscriptSegment:
        """
        Transcribe a buffer of s16le PCM audio.

        Converts PCM → float32 numpy array, acquires a free WhisperModel,
        runs transcription in a thread executor, and returns the result.

        Words whose window-relative start time is less than `cutoff_time` are
        filtered out before text is assembled. This eliminates phrases that
        Whisper has repeated from a previous window due to initial_prompt
        looping, without requiring any string comparison or heuristics.

        On inference failure the model instance is discarded from the pool
        and TranscriptionError is raised.

        Args:
            cutoff_time: Window-relative seconds. Words starting before this
                         time are dropped. The service layer computes this as
                         (last_word_end − window_time_offset), which converts
                         the session-level last_word_end into the coordinate
                         space of this window's audio buffer.
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
                    initial_prompt,
                    cutoff_time,
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
            "transcribed session=%s text=%r confidence=%.2f last_word_end=%.3f",
            session_id, result.text, result.confidence, result.last_word_end,
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
    model:          WhisperModel,
    audio:          np.ndarray,
    language:       str,
    initial_prompt: str   = "",
    cutoff_time:    float = 0.0,
) -> TranscriptSegment:
    """
    Synchronous transcription call — runs inside a thread executor.

    Requests word-level timestamps from faster-whisper and filters out any
    word whose start time (relative to this buffer's t=0) is less than
    cutoff_time. This removes phrases that Whisper has replayed from the
    initial_prompt context without requiring string matching.

    The returned TranscriptSegment carries:
      - text: the deduplicated, space-joined transcript for this window
      - words: the accepted WordTiming list (for diagnostics / future use)
      - last_word_end: end time of the last accepted word, in window-relative
        seconds. The service layer adds the window's session-level time offset
        to convert this back to a session-level cutoff for the next window.

    Any exception raised here propagates back to WhisperPool.transcribe(),
    which catches it, discards the model instance, and re-raises as
    TranscriptionError.
    """
    kwargs: dict = dict(
        language         = language,
        vad_filter       = True,
        beam_size        = 5,
        word_timestamps  = True,
    )
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    segments_gen, _info = model.transcribe(audio, **kwargs)
    segments = list(segments_gen)

    if not segments:
        return TranscriptSegment(text="", confidence=0.0)

    # Collect all words across all segments, filtered by cutoff_time.
    accepted: list[WordTiming] = []
    for seg in segments:
        for w in (seg.words or []):
            # w.start and w.end are relative to this buffer's beginning.
            if w.start >= cutoff_time:
                accepted.append(WordTiming(
                    word  = w.word,
                    start = w.start,
                    end   = w.end,
                ))

    if not accepted:
        # All words were filtered (entire window is a repeat) — return empty.
        return TranscriptSegment(text="", confidence=0.0)

    text          = " ".join(w.word.strip() for w in accepted if w.word.strip())
    last_word_end = accepted[-1].end

    avg_logprob = sum(s.avg_logprob for s in segments) / len(segments)
    confidence  = float(min(1.0, max(0.0, 1.0 + avg_logprob)))

    return TranscriptSegment(
        text          = text,
        confidence    = confidence,
        words         = accepted,
        last_word_end = last_word_end,
    )