"""
TranscriptionService — orchestrates audio receipt, VAD windowing,
Whisper dispatch, and Transcript emission for all active sessions.

This is the service layer sitting between the WebSocket handlers and the
TranscriptionPoolInterface. It owns:
  - VAD accumulation logic (Phase 2: real VAD; Phase 1: flush-only)
  - Deciding when to call pool.transcribe()
  - Formatting and sending TranscriptMessage over the session WebSocket

The pool interface is injected so the real WhisperPool can be swapped in
without touching any of this logic.
"""

from __future__ import annotations

import base64
import json
import logging

from fastapi import WebSocket

from interfaces import AudioChunk, TranscriptionPoolInterface, TranscriptMessage
from session_store import SessionStore

logger = logging.getLogger(__name__)

# Minimum PCM buffer size before a rolling mid-clip window is dispatched.
# At 16kHz s16le (2 bytes/sample): 2s = 64_000 bytes.
_MIN_BUFFER_BYTES = 64_000


class TranscriptionService:
    """
    Coordinates audio receipt → pool dispatch → Transcript emission.

    One shared instance per container process, injected into all route handlers.
    """

    def __init__(self, pool: TranscriptionPoolInterface, store: SessionStore) -> None:
        self._pool  = pool
        self._store = store

    # ── Session lifecycle ─────────────────────────────────────────────────────

    def open_session(self, session_id: str, websocket: WebSocket) -> None:
        """Register a new WebSocket connection for this session."""
        self._store.open(session_id, websocket)
        logger.info("session opened: %s", session_id)

    def close_session(self, session_id: str) -> None:
        """Remove session state on WebSocket disconnect."""
        self._store.close(session_id)
        logger.info("session closed: %s", session_id)

    def reset_session(self, session_id: str) -> None:
        """
        Clear the VAD buffer between clips.
        Called by POST /transcription/reset/{session_id}.
        """
        self._store.reset(session_id)
        logger.debug("session reset: %s", session_id)

    # ── Audio ingestion ───────────────────────────────────────────────────────

    async def on_audio_chunk(self, session_id: str, raw_msg: dict) -> None:
        """
        Process one AudioChunk received over the WebSocket.

        Decodes the base64 PCM and appends it to the session buffer.

        Phase 3: this method will also check the buffer against the rolling
        window threshold and call _transcribe_window() for mid-clip partials,
        keeping a tail overlap to avoid boundary word truncation.
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
        """
        entry = self._store.get(session_id)
        if entry is None:
            logger.warning("finalise called for unknown session: %s", session_id)
            return False

        pcm = bytes(entry.pcm_buffer)

        # Clear the buffer before dispatching so a second finalise() call
        # (or a reset() that races with a slow Whisper call) cannot
        # retranscribe the same audio.
        entry.pcm_buffer.clear()

        if pcm:
            segment = await self._pool.transcribe(
                pcm         = pcm,
                sample_rate = 16_000,
                session_id  = session_id,
            )
            text       = segment.text
            confidence = segment.confidence
        else:
            # Nothing in the buffer — emit an empty final segment so the
            # App container's ClipSession can still resolve its promise.
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

        await self._send(entry.websocket, msg)
        logger.debug("finalised session %s (seq=%d, len=%d bytes)", session_id, seq, len(pcm))
        return True

    # ── Internal ──────────────────────────────────────────────────────────────

    async def _transcribe_window(self, session_id: str, is_final: bool) -> None:
        """
        Transcribe the current buffer contents and emit a Transcript message.
        Consumes the entire buffer — each window covers a clean, non-overlapping
        segment of audio so ClipSession can safely concatenate all partials into
        a single transcript without duplication.
        """
        entry = self._store.get(session_id)
        if entry is None:
            return

        pcm = bytes(entry.pcm_buffer)
        entry.pcm_buffer.clear()

        if not pcm:
            return

        segment = await self._pool.transcribe(
            pcm         = pcm,
            sample_rate = 16_000,
            session_id  = session_id,
        )

        seq = self._store.next_seq(session_id)
        msg = TranscriptMessage(
            session_id = session_id,
            text       = segment.text,
            window_seq = seq,
            is_final   = is_final,
            confidence = segment.confidence,
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