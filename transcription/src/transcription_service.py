"""
TranscriptionService — orchestrates audio receipt, VAD windowing,
Whisper dispatch, and Transcript emission for all active sessions.

This is the service layer sitting between the WebSocket handlers and the
TranscriptionPoolInterface. It owns:
  - Silence gating (skip the pool entirely for silent windows)
  - Rolling window dispatch with initial_prompt and cutoff_time threading
  - Cross-window deduplication via word timestamps
  - Formatting and sending TranscriptMessage over the session WebSocket

The pool interface is injected so the real WhisperPool can be swapped in
without touching any of this logic.

Deduplication design
────────────────────
Whisper's initial_prompt seeding can cause "looping" — the decoder replays
phrases from the prompt at the start of a new window. We eliminate this using
faster-whisper's per-word timestamps:

  1. Each window's PCM byte count is converted to a session-level time offset:
       window_offset = entry.pcm_bytes_consumed / BYTES_PER_SECOND
     (pcm_bytes_consumed is incremented before the pool call so finalise and
     rolling windows share the same counter.)

  2. The session-level last_word_end is converted back to a window-relative
     cutoff before being passed to the pool:
       cutoff_time = entry.last_word_end - window_offset
     Words with window-relative start < cutoff_time are dropped by the pool.

  3. The pool returns last_word_end in window-relative seconds. The service
     converts it back to session-level and stores it on the entry:
       entry.last_word_end = window_offset + segment.last_word_end

  Both pcm_bytes_consumed and last_word_end are reset by reset_session()
  between clips so each clip starts clean.
"""

from __future__ import annotations

import base64
import json
import logging
import math

from fastapi import WebSocket

from interfaces import AudioChunk, TranscriptionPoolInterface, TranscriptMessage
from session_store import SessionStore, BYTES_PER_SECOND

logger = logging.getLogger(__name__)

# ── Rolling window threshold ──────────────────────────────────────────────────
# At 16 kHz s16le (2 bytes/sample): 192_000 bytes = 6 s.
_MIN_BUFFER_BYTES = 192_000

# ── Silence gate ──────────────────────────────────────────────────────────────
# RMS threshold below which a window is considered silent (~-44 dBFS).
_SILENCE_RMS_THRESHOLD = 200


class TranscriptionService:
    """
    Coordinates audio receipt → pool dispatch → Transcript emission.
    One shared instance per container process.
    """

    def __init__(self, pool: TranscriptionPoolInterface, store: SessionStore) -> None:
        self._pool  = pool
        self._store = store
        self._last_text: dict[str, str] = {}

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def open_session(self, session_id: str, websocket: WebSocket, language: str) -> None:
        """Register a new WebSocket connection for this session."""
        self._store.open(session_id, websocket, language)
        self._last_text.pop(session_id, None)
        logger.info("session opened: %s (language=%s)", session_id, language)

    def close_session(self, session_id: str) -> None:
        """Remove session state on WebSocket disconnect."""
        self._store.close(session_id)
        self._last_text.pop(session_id, None)
        logger.info("session closed: %s", session_id)

    def reset_session(self, session_id: str) -> None:
        """Clear the VAD buffer, prompt cache, and deduplication state between clips."""
        self._store.reset(session_id)
        self._last_text.pop(session_id, None)
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
        Flush remaining audio, apply deduplication, and emit is_final=True.
        Returns True if the session was known, False otherwise.
        """
        entry = self._store.get(session_id)
        if entry is None:
            logger.warning("finalise called for unknown session: %s", session_id)
            return False

        async with entry.flush_lock:
            pcm = bytes(entry.pcm_buffer)
            entry.pcm_buffer.clear()

        if pcm and not _is_silent(pcm):
            text, confidence = await self._dispatch_to_pool(session_id, pcm, entry)
        else:
            if pcm:
                logger.debug("finalise: silent window for session %s — skipping pool", session_id)
            text       = ""
            confidence = 1.0

        seq = self._store.next_seq(session_id)
        msg = TranscriptMessage(
            session_id = session_id,
            text       = text,
            window_seq = seq,
            is_final   = True,
            confidence = confidence,
        )

        # Re-fetch entry in case it was replaced between lock release and send.
        entry = self._store.get(session_id)
        if entry is None:
            logger.warning("session %s disappeared before final transcript could be sent", session_id)
            return False

        await self._send(entry.websocket, msg)
        logger.debug("finalised session %s (seq=%d, len=%d bytes)", session_id, seq, len(pcm))
        return True

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _transcribe_window(self, session_id: str, is_final: bool) -> None:
        """
        Snapshot the buffer, gate on silence, dispatch to pool with deduplication,
        and emit a Transcript message.
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

        text, confidence = await self._dispatch_to_pool(session_id, pcm, entry)

        seq = self._store.next_seq(session_id)
        msg = TranscriptMessage(
            session_id = session_id,
            text       = text,
            window_seq = seq,
            is_final   = is_final,
            confidence = confidence,
        )

        await self._send(entry.websocket, msg)

    async def _dispatch_to_pool(
        self,
        session_id: str,
        pcm:        bytes,
        entry:      object,  # SessionEntry — avoids circular import in type hint
    ) -> tuple[str, float]:
        """
        Compute the window time offset and cutoff, call the pool, update
        deduplication state, and return (text, confidence).

        The offset/cutoff math:
          - window_offset: session-level start time of this buffer (seconds)
          - cutoff_time:   window-relative threshold; words starting before
                           this point are repeats from a previous window
        """
        from session_store import SessionEntry  # local to avoid top-level circular
        assert isinstance(entry, SessionEntry)

        window_offset = entry.pcm_bytes_consumed / BYTES_PER_SECOND

        # Advance the consumed counter before the pool call so a concurrent
        # finalise() (if it somehow bypasses the lock) cannot reuse this range.
        entry.pcm_bytes_consumed += len(pcm)

        # Convert the session-level last_word_end into this window's coordinate
        # space. If last_word_end <= window_offset all words in this window are
        # fresh (cutoff_time ≤ 0), so pass 0.0 to avoid filtering anything.
        cutoff_time = max(0.0, entry.last_word_end - window_offset)

        try:
            segment = await self._pool.transcribe(
                pcm            = pcm,
                sample_rate    = 16_000,
                session_id     = session_id,
                initial_prompt = self._last_text.get(session_id, ""),
                language       = entry.language,
                cutoff_time    = cutoff_time,
            )
            text       = segment.text
            confidence = segment.confidence

            if text:
                self._last_text[session_id] = text

            # Convert window-relative last_word_end back to session-level.
            if segment.last_word_end > 0.0:
                entry.last_word_end = window_offset + segment.last_word_end

        except Exception as exc:
            logger.warning(
                "Whisper error for session %s — emitting empty segment: %s",
                session_id, exc,
            )
            text       = ""
            confidence = 0.0

        return text, confidence

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