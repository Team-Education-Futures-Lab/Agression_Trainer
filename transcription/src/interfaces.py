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
class TranscriptSegment:
    """
    The result of transcribing a single window of audio.
    Produced by TranscriptionPoolInterface.transcribe() and emitted to the
    App container as a Transcript WebSocket message.
    """
    text:       str
    confidence: float           # 0.0–1.0; stub always returns 1.0


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
    s16le PCM bytes, return a TranscriptSegment. All VAD accumulation and
    window management is handled by the service layer (TranscriptionService).

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
        initial_prompt: str = "",
    ) -> TranscriptSegment:
        """
        Transcribe a contiguous buffer of s16le PCM audio.

        This call may be CPU/GPU bound. Implementations must ensure they do
        not block the asyncio event loop (use run_in_executor for sync libs).

        Args:
            pcm:            Raw s16le PCM bytes at the given sample_rate.
            sample_rate:    Hz — always 16000 in this system.
            session_id:     Used for logging and tracing only; no state is kept.
            initial_prompt: Optional prior transcript text used to seed the
                            decoder's attention. Reduces hallucination on short
                            or context-sparse windows. Ignored by the stub.

        Returns:
            A TranscriptSegment with the recognised text and confidence score.
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