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

    In TranscriptSegment (internal), times are relative to the start of the
    audio buffer passed to transcribe() — which is overlap_pcm + new_pcm.
    The TranscriptionService converts these to session-level times (seconds
    from clip start) by adding overlap_session_start before emission.

    In TranscriptMessage (wire format), times are session-level (seconds from
    the start of the clip, i.e. from the last reset). These session-level
    times are forwarded by the App container in the AnalysisWindow sent to
    the Evaluation container, where they are used to compute silence_ratio
    and speech_pace accurately.
    """
    word:  str
    start: float    # seconds (context-dependent — see docstring above)
    end:   float    # seconds (context-dependent — see docstring above)


@dataclass
class TranscriptSegment:
    """
    The result of transcribing a single window of audio.
    Produced by TranscriptionPoolInterface.transcribe() and consumed by
    TranscriptionService before emission.

    `words` carries per-word timings relative to the start of the buffer
    passed to transcribe() (which is overlap_pcm + new_pcm). The service
    layer converts them to session-level times by adding overlap_session_start.

    `text` is the space-joined string of all returned words, ready to be
    filtered and emitted by the service layer.

    The pool returns all words without any filtering — duplicate filtering
    is the responsibility of the service layer using emitted_until.
    """
    text:       str
    confidence: float               # 0.0–1.0; stub always returns 1.0
    words:      list[WordTiming] = field(default_factory=list)


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
    s16le PCM bytes, transcribe the audio and return all recognised words
    with their timestamps. No filtering is performed by the pool — duplicate
    filtering via the emitted_until cutoff is handled entirely by the service
    layer. All VAD accumulation, window management, and overlap state are
    managed by the service layer.

    Implementations:
      - StubTranscriptionPool  (stubs/stub_transcription_pool.py)
      - WhisperPool            (whisper_pool.py)
    """

    @abstractmethod
    async def transcribe(
        self,
        pcm:         bytes,
        sample_rate: int,
        session_id:  str,
        language:    str = "",
    ) -> TranscriptSegment:
        """
        Transcribe a contiguous buffer of s16le PCM audio.

        Returns a TranscriptSegment with text and word timings relative to
        the start of the given PCM buffer (t=0). All words are returned
        without any filtering.

        The service layer:
          1. Prepends overlap_pcm to the new audio before calling this method.
          2. Converts the returned word timestamps to session-level times by
             adding entry.overlap_session_start.
          3. Skips words whose session-level end time <= entry.emitted_until
             (they are in the overlap region, already sent).
          4. Emits the remaining words and updates entry.emitted_until.
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