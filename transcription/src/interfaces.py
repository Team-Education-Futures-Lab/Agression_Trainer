# =============================================================================
# AR Training — Transcription Container Interfaces
# Abstract base classes and dataclasses for all Transcription DTOs.
#
# TypeScript equivalent: shared/types.ts (AudioChunk, Transcript fields)
# Wire format reference: docs/api_contract.md
# =============================================================================

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


# ─── Dataclasses ──────────────────────────────────────────────────────────────

@dataclass
class AudioChunk:
    """
    One chunk of audio data received from the App container over WebSocket.
    Mirrors the TypeScript AudioChunk DTO in shared/types.ts.
    """
    session_id:  str
    chunk_id:    int
    timestamp:   float
    pcm:         bytes          # Raw s16le PCM, decoded from base64 before use
    sample_rate: int            # Always 16000 Hz
    mfccs:       list[list[float]] = field(default_factory=list)


@dataclass
class WordTiming:
    """
    A single recognised word with its start and end time relative to the
    beginning of the audio buffer it was transcribed from.

    Used internally by TranscriptionService for cross-window deduplication.
    Not serialised over the wire — TranscriptMessage carries plain text only.
    """
    word:  str
    start: float    # seconds from start of this window's audio buffer
    end:   float    # seconds from start of this window's audio buffer


@dataclass
class TranscriptSegment:
    """
    The result of transcribing a single window of audio.
    Produced by TranscriptionPoolInterface.transcribe() and consumed by
    TranscriptionService for deduplication before emission.

    `words` carries per-word timings so the service layer can filter out any
    word that overlaps audio already covered by a previous window.
    `text` is the pre-joined, pre-filtered string ready to emit; it is set
    by the pool after filtering has been applied.
    """
    text:       str
    confidence: float               # 0.0–1.0; stub always returns 1.0
    words:      list[WordTiming] = field(default_factory=list)
    # The end time (relative to this window's audio) of the last accepted word.
    # Returned to the service so it can advance the session-level cutoff.
    last_word_end: float = 0.0


@dataclass
class TranscriptMessage:
    """
    Wire format for Transcript messages sent back to the App container.
    Serialised to JSON and sent over the session WebSocket.
    """
    session_id: str
    text:       str
    window_seq: int             # Monotonically increasing per session
    is_final:   bool
    confidence: float
    type:       str = "transcript"


@dataclass
class HealthStatus:
    """
    Response body for GET /transcription/health.
    """
    status:          str        # "ok"
    whisper_workers: WorkerStatus = field(default_factory=lambda: WorkerStatus(0, 0))
    device:          str = "cpu"


@dataclass
class WorkerStatus:
    total:     int
    available: int


# ─── Interfaces ───────────────────────────────────────────────────────────────

class TranscriptionPoolInterface(ABC):
    """
    Abstracts the Whisper worker pool.

    The pool has a single responsibility: given a contiguous buffer of raw
    s16le PCM bytes and a cutoff time, transcribe the audio and return only
    the words that start at or after the cutoff. All VAD accumulation, window
    management, and cutoff tracking is handled by the service layer.

    Implementations:
      - StubTranscriptionPool  (stubs/stub_transcription_pool.py)
      - WhisperPool            (whisper_pool.py)
    """

    @abstractmethod
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
        Transcribe a contiguous buffer of s16le PCM audio.

        This call may be CPU/GPU bound. Implementations must ensure they do
        not block the asyncio event loop (use run_in_executor for sync libs).

        Args:
            pcm:            Raw s16le PCM bytes at the given sample_rate.
            sample_rate:    Hz — always 16000 in this system.
            session_id:     Used for logging and tracing only; no state is kept.
            initial_prompt: Prior transcript text to seed Whisper's decoder,
                            reducing hallucination on short windows.
            language:       ISO 639-1 language code. Overrides the pool-level
                            default when provided.
            cutoff_time:    Audio-relative time (seconds) before which words
                            are considered already covered by a previous window
                            and should be filtered out. Words with start < cutoff
                            are dropped before text is assembled.

        Returns:
            A TranscriptSegment with deduplicated text, word timings, and the
            end time of the last accepted word.
        """
        ...

    @property
    @abstractmethod
    def worker_count(self) -> int:
        """Total number of Whisper workers in the pool."""
        ...

    @property
    @abstractmethod
    def available_workers(self) -> int:
        """Number of workers not currently processing a request."""
        ...

    @property
    @abstractmethod
    def device(self) -> str:
        """Inference device: 'cpu' or 'cuda'."""
        ...