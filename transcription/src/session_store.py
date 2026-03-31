"""
In-memory store for per-session transcription state.

Each session entry holds:
  - The live WebSocket connection (so finalise can push a final Transcript)
  - The raw PCM accumulation buffer (for VAD windowing and flush)
  - A monotonically increasing window_seq counter
  - A flush_lock that serialises _transcribe_window and finalise so a
    concurrent finalise() call cannot race to read the same buffer bytes
    that a rolling window is already transcribing.
  - The per-session language code (ISO 639-1) passed by the App container
    when the WebSocket is opened. Overrides the container-level WHISPER_LANGUAGE
    default so different scenarios can use different transcription languages.

No shared state between container instances — session pinning is handled by
the App container's ServiceRouter, so each instance only ever sees one
connection per session_id.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from fastapi import WebSocket

logger = logging.getLogger(__name__)

# Maximum PCM buffer size per session (bytes).
# At 16kHz s16le (2 bytes/sample) a 120-second clip produces 3,840,000 bytes.
# 4 MB = 4,194,304 bytes gives headroom above the 120 s worst case while
# capping runaway growth from a misbehaving client.
# Note: under normal operation with rolling windows active (_MIN_BUFFER_BYTES
# = 192_000), the effective peak buffer size is ~192 KB, not 4 MB — the cap
# is a defence against a client that streams audio without the rolling window
# ever firing (e.g. extremely quiet audio that always triggers the silence
# gate). In that case the full clip accumulates here and is flushed at finalise.
_MAX_PCM_BUFFER_BYTES = 4 * 1024 * 1024


# ─── Per-session state ────────────────────────────────────────────────────────

@dataclass
class SessionEntry:
    websocket:  WebSocket
    language:   str              # ISO 639-1, e.g. "nl". Set at open time from the WS query param.
    pcm_buffer: bytearray    = field(default_factory=bytearray)
    window_seq: int          = 0
    flush_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


# ─── Store ────────────────────────────────────────────────────────────────────

class SessionStore:
    """
    Thread-safe in-memory registry of active transcription sessions.
    All access is from the asyncio event loop, so a plain dict is sufficient.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, SessionEntry] = {}

    def open(self, session_id: str, websocket: WebSocket, language: str) -> SessionEntry:
        """
        Register a new WebSocket connection for session_id.

        language is the ISO 639-1 code for this session's transcription language,
        supplied by the App container via the WebSocket URL query parameter.
        If a stale entry exists (e.g. from a previous clip's connection that
        closed without cleanup), it is replaced.
        """
        entry = SessionEntry(websocket=websocket, language=language)
        self._sessions[session_id] = entry
        return entry

    def get(self, session_id: str) -> SessionEntry | None:
        return self._sessions.get(session_id)

    def close(self, session_id: str) -> None:
        """
        Remove the session entry. Called when the WebSocket closes.
        Does not close the WebSocket itself — that is the handler's responsibility.
        """
        self._sessions.pop(session_id, None)

    def reset(self, session_id: str) -> None:
        """
        Clear the PCM buffer and reset the window_seq counter for a session.
        Called by POST /transcription/reset/{session_id} between clips.
        The WebSocket connection, language, and flush_lock are NOT replaced —
        the App container manages the connection lifecycle.
        """
        entry = self._sessions.get(session_id)
        if entry is not None:
            entry.pcm_buffer.clear()
            entry.window_seq = 0

    def append_pcm(self, session_id: str, pcm: bytes) -> None:
        """
        Append raw PCM bytes to the session's accumulation buffer.

        Bytes that would push the buffer past _MAX_PCM_BUFFER_BYTES are
        silently dropped. This is a denial-of-service defence — see the
        module-level note on when the cap can legitimately be reached.
        """
        entry = self._sessions.get(session_id)
        if entry is None:
            return
        available = _MAX_PCM_BUFFER_BYTES - len(entry.pcm_buffer)
        if available <= 0:
            logger.warning(
                "PCM buffer cap reached for session %s — dropping %d bytes",
                session_id, len(pcm),
            )
            return
        if len(pcm) > available:
            logger.warning(
                "PCM buffer cap reached for session %s — truncating chunk from %d to %d bytes",
                session_id, len(pcm), available,
            )
            entry.pcm_buffer.extend(pcm[:available])
        else:
            entry.pcm_buffer.extend(pcm)

    def next_seq(self, session_id: str) -> int:
        """Increment and return the next window_seq for this session."""
        entry = self._sessions.get(session_id)
        if entry is None:
            return 0
        entry.window_seq += 1
        return entry.window_seq

    def __contains__(self, session_id: str) -> bool:
        return session_id in self._sessions