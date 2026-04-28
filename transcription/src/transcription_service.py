"""
TranscriptionService — orchestrates audio receipt, VAD windowing,
Whisper dispatch, and Transcript emission for all active sessions.

This is the service layer sitting between the WebSocket handlers and the
TranscriptionPoolInterface. It owns:
  - Silence gating (skip the pool entirely for silent windows)
  - Overlap-window dispatch (prepend tail audio from the previous window)
  - Cross-window duplicate filtering via session-level word-end timestamps
  - Formatting and sending TranscriptMessage over the session WebSocket

Overlap-window strategy
────────────────────────
Instead of using text-based initial_prompt seeding (which causes Whisper to
replay old words at the start of a new window) and a byte-count-derived
cutoff to remove duplicates (which drifts over time), this service uses an
audio-overlap approach:

  1. After each window is transcribed, the audio corresponding to the last
     _OVERLAP_WORDS words is stored as entry.overlap_pcm.

  2. Before dispatching the next window to the pool, entry.overlap_pcm is
     prepended to the new audio buffer. The pool receives and decodes the
     combined buffer in one shot, producing a single coherent transcript.

  3. After transcription, pool-returned word timestamps are offset by
     entry.overlap_session_start (the session-level time at which overlap_pcm
     begins) to convert them to session-level (clip-relative) times.

  4. Words whose session-level end time is <= entry.emitted_until were already
     sent to the App container in a previous window and are silently skipped.
     Words past this boundary are new; they are emitted and emitted_until
     is advanced to the session-level end of the last emitted word.

This is more robust than byte-count-based offset computation because:
  - overlap_session_start and emitted_until come from Whisper's own word
    boundary timestamps, not from byte counts that drift with unaligned chunks.
  - No text is injected into the decoder, eliminating prompt-looping entirely.
  - Long words that straddle a boundary are decoded cleanly in context and
    appear exactly once.

Word timing semantics
──────────────────────
The pool returns word timings relative to the start of the buffer it was
given (overlap_pcm + new_pcm). Before emission, the service converts these
to session-level (clip-relative) seconds by adding overlap_session_start:

  session_level_time = pool_relative_time + entry.overlap_session_start

This produces clip-relative word timings that the App container can include
in the AnalysisWindow dispatched to the Evaluation container, enabling
accurate silence_ratio and speech_pace computation.
"""

from __future__ import annotations

import base64
import json
import logging
import math

from fastapi import WebSocket

from interfaces import (
    AudioChunk, TranscriptionPoolInterface, TranscriptMessage, WordTiming,
)
from session_store import SessionStore, BYTES_PER_SECOND

logger = logging.getLogger(__name__)

# ── Rolling window threshold ──────────────────────────────────────────────────
# At 16 kHz s16le (2 bytes/sample): 192_000 bytes = 6 s.
_MIN_BUFFER_BYTES = 192_000

# ── Silence gate ──────────────────────────────────────────────────────────────
# RMS threshold below which a window is considered silent (~-44 dBFS).
_SILENCE_RMS_THRESHOLD = 200

# ── Overlap configuration ─────────────────────────────────────────────────────
# Number of words from the tail of the accepted word list to keep as audio
# overlap. The audio spanning these words is prepended to the next window's
# buffer, giving Whisper acoustic context across window boundaries without
# text-based prompt injection.
_OVERLAP_WORDS = 3


class TranscriptionService:
    """
    Coordinates audio receipt → pool dispatch → Transcript emission.
    One shared instance per container process.
    """

    def __init__(self, pool: TranscriptionPoolInterface, store: SessionStore) -> None:
        self._pool  = pool
        self._store = store

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def open_session(self, session_id: str, websocket: WebSocket, language: str = "") -> None:
        """Register a new WebSocket connection for this session."""
        self._store.open(session_id, websocket, language)
        logger.info("session opened: %s (language=%s)", session_id, language)

    def close_session(self, session_id: str) -> None:
        """Remove session state on WebSocket disconnect."""
        self._store.close(session_id)
        logger.info("session closed: %s", session_id)

    def reset_session(self, session_id: str) -> None:
        """Clear the VAD buffer and all overlap/deduplication state between clips."""
        self._store.reset(session_id)
        logger.debug("session reset: %s", session_id)

    # ── Audio ingestion ───────────────────────────────────────────────────────

    async def on_audio_chunk(self, session_id: str, raw_msg: dict) -> None:
        """Decode PCM, append to buffer, fire rolling window when threshold reached."""
        pcm_b64 = raw_msg.get("pcm", "")
        if not pcm_b64:
            return

        try:
            pcm = base64.b64decode(pcm_b64)
        except Exception:
            logger.warning("invalid base64 PCM in session %s", session_id)
            return

        self._store.append_pcm(session_id, pcm)

        entry = self._store.get(session_id)
        if entry and len(entry.pcm_buffer) >= _MIN_BUFFER_BYTES:
            await self._transcribe_window(session_id, is_final=False)

    # ── Finalise ──────────────────────────────────────────────────────────────

    async def finalise(self, session_id: str) -> bool:
        """
        Flush remaining audio and emit is_final=True.
        Returns True if the session was known, False otherwise.

        Prepends overlap_pcm as usual. If the remaining buffer (excluding
        overlap) is empty or silent, emits an empty final transcript without
        calling the pool. After dispatch, overlap_pcm is cleared.
        """
        entry = self._store.get(session_id)
        if entry is None:
            logger.warning("finalise called for unknown session: %s", session_id)
            return False

        async with entry.flush_lock:
            pcm = bytes(entry.pcm_buffer)
            entry.pcm_buffer.clear()

        combined = entry.overlap_pcm + pcm

        if combined and not _is_silent(combined) and pcm:
            text, confidence, words = await self._dispatch_to_pool(
                session_id, pcm, entry
            )
        else:
            if pcm and _is_silent(pcm):
                logger.debug("finalise: silent window for session %s — skipping pool", session_id)
            text       = ""
            confidence = 1.0
            words      = []

        # Clear overlap after the final dispatch.
        entry = self._store.get(session_id)
        if entry is not None:
            entry.overlap_pcm           = b""
            entry.overlap_session_start = 0.0

        seq = self._store.next_seq(session_id)
        msg = TranscriptMessage(
            session_id = session_id,
            text       = text,
            window_seq = seq,
            is_final   = True,
            confidence = confidence,
            words      = words,
        )

        # Re-fetch entry in case it was replaced between lock release and send.
        entry = self._store.get(session_id)
        if entry is None:
            logger.warning("session %s disappeared before final transcript could be sent", session_id)
            return False

        await self._send(entry.websocket, msg)
        logger.debug("finalised session %s (seq=%d, new_bytes=%d)", session_id, seq, len(pcm))
        return True

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _transcribe_window(self, session_id: str, is_final: bool) -> None:
        """
        Snapshot the buffer, gate on silence, dispatch to pool with overlap,
        filter duplicates, and emit a Transcript message.
        """
        entry = self._store.get(session_id)
        if entry is None:
            return

        async with entry.flush_lock:
            pcm = bytes(entry.pcm_buffer)
            entry.pcm_buffer.clear()

        if not pcm:
            return

        if _is_silent(pcm):
            logger.debug("rolling window: silent — skipping pool for session %s", session_id)
            return

        text, confidence, words = await self._dispatch_to_pool(session_id, pcm, entry)

        seq = self._store.next_seq(session_id)
        msg = TranscriptMessage(
            session_id = session_id,
            text       = text,
            window_seq = seq,
            is_final   = is_final,
            confidence = confidence,
            words      = words,
        )

        await self._send(entry.websocket, msg)

    async def _dispatch_to_pool(
        self,
        session_id: str,
        new_pcm:    bytes,
        entry:      object,  # SessionEntry — avoids circular import in type hint
    ) -> tuple[str, float, list[WordTiming]]:
        """
        Prepend overlap_pcm to new_pcm, call the pool, filter the overlap
        region, update overlap state, and return (text, confidence, words).

        Words are returned with session-level (clip-relative) times, computed
        by adding entry.overlap_session_start to pool-relative timestamps.

        If the pool returns no words, overlap state is left unchanged so the
        existing overlap remains available as context for the next window.
        """
        from session_store import SessionEntry  # local to avoid top-level circular
        assert isinstance(entry, SessionEntry)

        combined = entry.overlap_pcm + new_pcm

        try:
            segment = await self._pool.transcribe(
                pcm        = combined,
                sample_rate = 16_000,
                session_id  = session_id,
                language    = entry.language,
            )
            raw_words  = segment.words
            confidence = segment.confidence

        except Exception as exc:
            logger.warning(
                "Whisper error for session %s — emitting empty segment: %s",
                session_id, exc,
            )
            return "", 0.0, []

        if not raw_words:
            # No words returned — keep existing overlap unchanged.
            return "", confidence, []

        # Convert pool-relative timestamps to session-level.
        session_words: list[WordTiming] = [
            WordTiming(
                word  = w.word,
                start = entry.overlap_session_start + w.start,
                end   = entry.overlap_session_start + w.end,
            )
            for w in raw_words
        ]

        # Filter out words in the overlap region (already emitted).
        new_words = [w for w in session_words if w.end > entry.emitted_until]

        # Update emitted_until to the end of the last new word.
        if new_words:
            entry.emitted_until = new_words[-1].end

        # Compute the new overlap: audio for the last _OVERLAP_WORDS accepted words.
        # "Accepted" here means words from session_words (unfiltered), so Whisper
        # always gets the last N words it decoded as context, regardless of which
        # side of the boundary they fall on.
        accepted_for_overlap = session_words
        if len(accepted_for_overlap) >= _OVERLAP_WORDS:
            overlap_start_word = accepted_for_overlap[-_OVERLAP_WORDS]
        else:
            overlap_start_word = accepted_for_overlap[0]

        # overlap_start_word.start is session-level. Convert to pool-relative to
        # compute the byte offset into `combined`.
        pool_relative_overlap_start = overlap_start_word.start - entry.overlap_session_start
        overlap_byte_offset = int(pool_relative_overlap_start * BYTES_PER_SECOND)
        overlap_byte_offset = max(0, min(overlap_byte_offset, len(combined)))
        overlap_byte_offset &= ~1   # align to 2-byte s16le sample boundary

        entry.overlap_pcm           = combined[overlap_byte_offset:]
        entry.overlap_session_start = overlap_start_word.start

        text = " ".join(w.word.strip() for w in new_words if w.word.strip())
        return text, confidence, new_words

    @staticmethod
    async def _send(websocket: WebSocket, msg: TranscriptMessage) -> None:
        """Serialise msg to JSON and send over the WebSocket. Non-fatal on error."""
        try:
            payload = {
                "type":       msg.type,
                "session_id": msg.session_id,
                "text":       msg.text,
                "window_seq": msg.window_seq,
                "is_final":   msg.is_final,
                "confidence": msg.confidence,
                "words":      [
                    {"word": w.word, "start": w.start, "end": w.end}
                    for w in msg.words
                ],
            }
            await websocket.send_text(json.dumps(payload))
        except Exception as exc:
            logger.warning("failed to send transcript for %s: %s", msg.session_id, exc)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_silent(pcm: bytes) -> bool:
    """Return True if the RMS of the PCM buffer is below the silence threshold."""
    if not pcm:
        return False
    n_samples = len(pcm) // 2
    if n_samples == 0:
        return False
    total = 0
    for i in range(0, len(pcm) - 1, 2):
        sample = int.from_bytes(pcm[i:i+2], byteorder="little", signed=True)
        total += sample * sample
    rms = math.sqrt(total / n_samples)
    return rms < _SILENCE_RMS_THRESHOLD