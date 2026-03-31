"""
TranscriptionService — orchestrates audio receipt, VAD windowing,
Whisper dispatch, and Transcript emission for all active sessions.

This is the service layer sitting between the WebSocket handlers and the
TranscriptionPoolInterface. It owns:
  - Silence gating (skip the pool entirely for silent windows)
  - Rolling window dispatch with initial_prompt threading
  - Formatting and sending TranscriptMessage over the session WebSocket

The pool interface is injected so the real WhisperPool can be swapped in
without touching any of this logic.
"""

from __future__ import annotations

import base64
import json
import logging
import math

from fastapi import WebSocket

from interfaces import AudioChunk, TranscriptionPoolInterface, TranscriptMessage
from session_store import SessionStore

logger = logging.getLogger(__name__)

# ── Rolling window threshold ──────────────────────────────────────────────────
# Minimum PCM buffer size before a rolling mid-clip window is dispatched.
# At 16 kHz s16le (2 bytes/sample):
#   64_000 bytes = 2 s  — original, high call-rate
#  192_000 bytes = 6 s  — current: reduces Whisper startup overhead per call
#                         while keeping peak unfinalised audio well under 4 MB.
_MIN_BUFFER_BYTES = 192_000

# ── Silence gate ──────────────────────────────────────────────────────────────
# RMS threshold below which a PCM window is considered silent and the pool is
# not called. Computed on int16 samples (range 0–32767). A value of 200
# corresponds to roughly -44 dBFS — well below typical speech from a laptop
# microphone (~2000–8000 RMS) but above idle electrical noise.
_SILENCE_RMS_THRESHOLD = 200


class TranscriptionService:
    """
    Coordinates audio receipt → pool dispatch → Transcript emission.

    One shared instance per container process, injected into all route handlers.
    """

    def __init__(self, pool: TranscriptionPoolInterface, store: SessionStore) -> None:
        self._pool  = pool
        self._store = store
        # Tracks the last successfully emitted transcript text per session.
        # Passed as initial_prompt to Whisper on subsequent calls to reduce
        # hallucination on short or context-sparse windows.
        self._last_text: dict[str, str] = {}

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def open_session(self, session_id: str, websocket: WebSocket, language: str) -> None:
        """
        Register a new WebSocket connection for this session.

        language is the ISO 639-1 code supplied by the App container via the
        WebSocket URL query parameter (e.g. "nl", "en"). Stored on the session
        entry and passed to every pool.transcribe() call so each session is
        transcribed in the correct language regardless of the container default.
        """
        self._store.open(session_id, websocket, language)
        self._last_text.pop(session_id, None)
        logger.info("session opened: %s (language=%s)", session_id, language)

    def close_session(self, session_id: str) -> None:
        """Remove session state on WebSocket disconnect."""
        self._store.close(session_id)
        self._last_text.pop(session_id, None)
        logger.info("session closed: %s", session_id)

    def reset_session(self, session_id: str) -> None:
        """
        Clear the VAD buffer and last-prompt cache between clips.
        Called by POST /transcription/reset/{session_id}.
        """
        self._store.reset(session_id)
        self._last_text.pop(session_id, None)
        logger.debug("session reset: %s", session_id)

    # ── Audio ingestion ───────────────────────────────────────────────────────

    async def on_audio_chunk(self, session_id: str, raw_msg: dict) -> None:
        """
        Process one AudioChunk received over the WebSocket.

        Decodes the base64 PCM and appends it to the session buffer.
        Fires a rolling mid-clip window when the buffer reaches
        _MIN_BUFFER_BYTES.
        """
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
        Flush any remaining audio in the buffer through Whisper and emit a
        final Transcript message (is_final=True) over the session WebSocket.

        Returns True if a final message was sent, False if the session is
        unknown (e.g. the WebSocket was never opened or already closed).

        Uses the per-session flush_lock to prevent a race with a concurrent
        in-flight rolling window.
        """
        entry = self._store.get(session_id)
        if entry is None:
            logger.warning("finalise called for unknown session: %s", session_id)
            return False

        async with entry.flush_lock:
            pcm = bytes(entry.pcm_buffer)

            # Clear the buffer before dispatching so a second finalise() call
            # (or a reset() that races with a slow Whisper call) cannot
            # retranscribe the same audio.
            entry.pcm_buffer.clear()

        if pcm and not _is_silent(pcm):
            try:
                segment = await self._pool.transcribe(
                    pcm            = pcm,
                    sample_rate    = 16_000,
                    session_id     = session_id,
                    initial_prompt = self._last_text.get(session_id, ""),
                    language       = entry.language,
                )
                text       = segment.text
                confidence = segment.confidence
                if text:
                    self._last_text[session_id] = text
            except Exception as exc:
                logger.warning(
                    "Whisper error during finalise for session %s — emitting empty final: %s",
                    session_id, exc,
                )
                text       = ""
                confidence = 0.0
        else:
            # Nothing meaningful in the buffer — emit an empty final segment
            # so the App container's ClipSession can still resolve its promise.
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
        Transcribe the current buffer contents and emit a Transcript message.

        Protected by the per-session flush_lock so a concurrent finalise()
        call cannot race to read and clear the same buffer.

        Silent windows are skipped: if the RMS of the buffer is below
        _SILENCE_RMS_THRESHOLD the pool is not called and no message is emitted.

        On Whisper error, emits an empty segment rather than propagating the
        exception, so the session remains alive.
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

        try:
            segment = await self._pool.transcribe(
                pcm            = pcm,
                sample_rate    = 16_000,
                session_id     = session_id,
                initial_prompt = self._last_text.get(session_id, ""),
                language       = entry.language,
            )
            text       = segment.text
            confidence = segment.confidence
            if text:
                self._last_text[session_id] = text
        except Exception as exc:
            logger.warning(
                "Whisper error during rolling window for session %s — emitting empty partial: %s",
                session_id, exc,
            )
            text       = ""
            confidence = 0.0

        seq = self._store.next_seq(session_id)
        msg = TranscriptMessage(
            session_id = session_id,
            text       = text,
            window_seq = seq,
            is_final   = is_final,
            confidence = confidence,
        )

        await self._send(entry.websocket, msg)

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
    """
    Return True if the RMS energy of the PCM buffer is below the silence
    threshold, indicating the window contains no meaningful speech.

    Operates on raw s16le bytes. Returns False (not silent) for empty input
    so an empty buffer still reaches the pool and returns an empty transcript
    rather than being silently discarded.
    """
    if not pcm:
        return False
    n_samples = len(pcm) // 2
    if n_samples == 0:
        return False
    # Interpret as signed 16-bit little-endian samples.
    total = 0
    for i in range(0, len(pcm) - 1, 2):
        sample = int.from_bytes(pcm[i:i+2], byteorder="little", signed=True)
        total += sample * sample
    rms = math.sqrt(total / n_samples)
    return rms < _SILENCE_RMS_THRESHOLD