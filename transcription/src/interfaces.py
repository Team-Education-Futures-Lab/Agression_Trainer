# =============================================================================
# AR Training — Transcription Container Interfaces
# Abstract base classes and dataclasses for all Transcription DTOs.
#
# TypeScript equivalent: shared/types.ts (AudioChunk, Transcript fields)
# Wire format reference: docs/admin_and_tooling_api.md
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
    A single recognised word with its start and end time.

    In TranscriptSegment (internal), times are window-relative (seconds from
    the start of the audio buffer being transcribed).

    In TranscriptMessage (wire format), times are session-level (seconds from
    the start of the clip, i.e. from the last reset). The TranscriptionService
    converts from window-relative to session-level before emission by adding
    the window's time offset.

    These session-level times are forwarded by the App container in the
    AnalysisWindow sent to the Evaluation container, where they are used to
    compute silence_ratio and speech_pace accurately.
    """
    word:  str
    start: float    # seconds (context-dependent — see docstring above)
    end:   float    # seconds (context-dependent — see docstring above)


@dataclass
class TranscriptSegment:
    """
    The result of transcribing a single window of audio.
    Produced by TranscriptionPoolInterface.transcribe() and consumed by
    TranscriptionService for deduplication before emission.

    `words` carries per-word timings in window-relative seconds. The service
    layer converts them to session-level times before forwarding.
    `text` is the pre-joined, pre-filtered string ready to emit.
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

    `words` carries session-level word timings (seconds from clip start).
    The App container accumulates these across all received messages and
    includes them in the AnalysisWindow dispatched to the Evaluation container.
    """
    session_id: str
    text:       str
    window_seq: int             # Monotonically increasing per session
    is_final:   bool
    confidence: float
    words:      list[WordTiming] = field(default_factory=list)
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

        Returns a TranscriptSegment with deduplicated text, word timings
        (window-relative), and the end time of the last accepted word.

        Word timings in the returned segment are relative to this buffer's
        t=0. The service layer adds the window's session-level time offset
        to convert them to session-level (clip-relative) times before
        forwarding to the App container.
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