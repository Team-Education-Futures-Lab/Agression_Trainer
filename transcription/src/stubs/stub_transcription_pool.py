"""
Stub implementation of TranscriptionPoolInterface.

Returns a canned TranscriptSegment without running Whisper.
Exists only for skeleton development and end-to-end pipeline testing
before the real Whisper pool is implemented.

Do NOT use in production.
"""

from __future__ import annotations

from interfaces import TranscriptionPoolInterface, TranscriptSegment


class StubTranscriptionPool(TranscriptionPoolInterface):
    """
    Returns hardcoded transcript text without calling Whisper.
    Always reports 1 worker, always available, always cpu.
    """

    async def transcribe(
        self,
        pcm:         bytes,
        sample_rate: int,
        session_id:  str,
    ) -> TranscriptSegment:
        # Return a fixed Dutch placeholder so downstream containers
        # (Evaluation, Feedback) receive non-empty transcript data.
        return TranscriptSegment(
            text="[stub] dit is een teststranscriptie.",
            confidence=1.0,
        )

    @property
    def worker_count(self) -> int:
        return 1

    @property
    def available_workers(self) -> int:
        return 1

    @property
    def device(self) -> str:
        return "cpu"