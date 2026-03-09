"""
Tests for TranscriptionService.

The pool and WebSocket are both mocked so these tests cover orchestration
logic only — buffer management, Whisper dispatch, and Transcript emission —
without any real I/O or inference.
"""

import base64
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from interfaces import TranscriptSegment
from session_store import SessionStore
from transcription_service import TranscriptionService


# ─── Helpers ──────────────────────────────────────────────────────────────────

def make_pool(text: str = "hallo wereld", confidence: float = 0.9) -> MagicMock:
    """Mock pool that resolves transcribe() with a fixed TranscriptSegment."""
    pool = MagicMock()
    pool.transcribe = AsyncMock(return_value=TranscriptSegment(text=text, confidence=confidence))
    return pool


def make_ws() -> MagicMock:
    """Mock FastAPI WebSocket with an async send_text."""
    ws = MagicMock()
    ws.send_text = AsyncMock()
    return ws


def make_audio_msg(pcm_bytes: bytes = b"\x00\x01" * 100) -> dict:
    """Build a minimal audio_chunk message dict with base64-encoded PCM."""
    return {
        "type":        "audio_chunk",
        "session_id":  "s1",
        "chunk_id":    1,
        "timestamp":   0.0,
        "pcm":         base64.b64encode(pcm_bytes).decode(),
        "sample_rate": 16_000,
        "mfccs":       [],
    }


def sent_messages(ws: MagicMock) -> list[dict]:
    """Return all JSON messages sent over the mock WebSocket."""
    return [
        json.loads(call.args[0])
        for call in ws.send_text.call_args_list
    ]


# ─── Session lifecycle ────────────────────────────────────────────────────────

class TestSessionLifecycle:
    def test_open_registers_session_in_store(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())
        assert "s1" in store

    def test_close_removes_session_from_store(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())
        svc.close_session("s1")
        assert "s1" not in store

    def test_close_unknown_session_does_not_raise(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.close_session("unknown")  # should not raise

    def test_reset_clears_buffer_but_keeps_session(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())
        store.append_pcm("s1", b"\x00" * 200)
        svc.reset_session("s1")
        assert "s1" in store
        assert len(store.get("s1").pcm_buffer) == 0


# ─── on_audio_chunk ───────────────────────────────────────────────────────────

class TestOnAudioChunk:
    @pytest.mark.asyncio
    async def test_appends_decoded_pcm_to_buffer(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        pcm = b"\x01\x02\x03\x04"
        await svc.on_audio_chunk("s1", make_audio_msg(pcm))

        assert bytes(store.get("s1").pcm_buffer) == pcm

    @pytest.mark.asyncio
    async def test_multiple_chunks_accumulate_in_order(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg(b"\xAA\xAA"))
        await svc.on_audio_chunk("s1", make_audio_msg(b"\xBB\xBB"))

        assert bytes(store.get("s1").pcm_buffer) == b"\xAA\xAA\xBB\xBB"

    @pytest.mark.asyncio
    async def test_missing_pcm_field_does_not_raise(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", {"type": "audio_chunk"})  # no pcm key

    @pytest.mark.asyncio
    async def test_invalid_base64_does_not_raise(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", {"type": "audio_chunk", "pcm": "not-valid-base64!!!"})

    @pytest.mark.asyncio
    async def test_does_not_call_pool_during_accumulation(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        for _ in range(10):
            await svc.on_audio_chunk("s1", make_audio_msg())

        pool.transcribe.assert_not_called()

    @pytest.mark.asyncio
    async def test_buffers_are_independent_per_session(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        ws1, ws2 = make_ws(), make_ws()
        svc.open_session("s1", ws1)
        svc.open_session("s2", ws2)

        await svc.on_audio_chunk("s1", make_audio_msg(b"\xAA"))
        await svc.on_audio_chunk("s2", make_audio_msg(b"\xBB"))

        assert bytes(store.get("s1").pcm_buffer) == b"\xAA"
        assert bytes(store.get("s2").pcm_buffer) == b"\xBB"


# ─── finalise ─────────────────────────────────────────────────────────────────

class TestFinalise:
    @pytest.mark.asyncio
    async def test_returns_false_for_unknown_session(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        result = await svc.finalise("unknown")
        assert result is False

    @pytest.mark.asyncio
    async def test_returns_true_for_known_session(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())
        result = await svc.finalise("s1")
        assert result is True

    @pytest.mark.asyncio
    async def test_calls_pool_with_accumulated_pcm(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        pcm = b"\x01\x02" * 50
        await svc.on_audio_chunk("s1", make_audio_msg(pcm))
        await svc.finalise("s1")

        pool.transcribe.assert_called_once()
        call_pcm = pool.transcribe.call_args.kwargs["pcm"]
        assert call_pcm == pcm

    @pytest.mark.asyncio
    async def test_does_not_call_pool_when_buffer_is_empty(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        await svc.finalise("s1")

        pool.transcribe.assert_not_called()

    @pytest.mark.asyncio
    async def test_emits_is_final_true_transcript(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool("hallo"), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg())
        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert len(msgs) == 1
        assert msgs[0]["type"] == "transcript"
        assert msgs[0]["is_final"] is True
        assert msgs[0]["text"] == "hallo"

    @pytest.mark.asyncio
    async def test_emits_empty_transcript_when_buffer_empty(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert len(msgs) == 1
        assert msgs[0]["is_final"] is True
        assert msgs[0]["text"] == ""

    @pytest.mark.asyncio
    async def test_emits_correct_session_id_in_transcript(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert msgs[0]["session_id"] == "s1"

    @pytest.mark.asyncio
    async def test_emits_correct_confidence_from_pool(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(confidence=0.75), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg())
        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert msgs[0]["confidence"] == pytest.approx(0.75)

    @pytest.mark.asyncio
    async def test_window_seq_starts_at_one_per_connection(self):
        # window_seq is per-WebSocket-connection, not per-session-lifetime.
        # Each clip opens a fresh connection → open_session() creates a new
        # SessionEntry with window_seq=0, so the first finalise always emits seq=1.
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)

        # Clip 1
        ws1 = make_ws()
        svc.open_session("s1", ws1)
        await svc.on_audio_chunk("s1", make_audio_msg())
        await svc.finalise("s1")
        svc.close_session("s1")

        # Clip 2 — new WebSocket, new SessionEntry
        ws2 = make_ws()
        svc.open_session("s1", ws2)
        await svc.on_audio_chunk("s1", make_audio_msg())
        await svc.finalise("s1")

        assert sent_messages(ws1)[0]["window_seq"] == 1
        assert sent_messages(ws2)[0]["window_seq"] == 1

    @pytest.mark.asyncio
    async def test_window_seq_increments_within_one_connection(self):
        # If _transcribe_window is called multiple times on the same connection
        # (Phase 3 partials), window_seq should increment monotonically.
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        # Manually call _transcribe_window twice to simulate two partial windows
        store.append_pcm("s1", b"\x00" * 64)
        await svc._transcribe_window("s1", is_final=False)
        store.append_pcm("s1", b"\x00" * 64)
        await svc._transcribe_window("s1", is_final=True)

        msgs = sent_messages(ws)
        assert msgs[0]["window_seq"] == 1
        assert msgs[1]["window_seq"] == 2

    @pytest.mark.asyncio
    async def test_clears_buffer_after_dispatch(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg(b"\x01\x02" * 50))
        await svc.finalise("s1")

        assert len(store.get("s1").pcm_buffer) == 0

    @pytest.mark.asyncio
    async def test_second_finalise_does_not_call_pool_again(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg())
        await svc.finalise("s1")   # clears buffer, calls pool once
        await svc.finalise("s1")   # buffer is empty — pool should not be called again

        assert pool.transcribe.call_count == 1

    @pytest.mark.asyncio
    async def test_send_failure_does_not_propagate(self):
        store = SessionStore()
        ws    = make_ws()
        ws.send_text = AsyncMock(side_effect=Exception("connection lost"))
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        # Should not raise
        await svc.on_audio_chunk("s1", make_audio_msg())
        await svc.finalise("s1")


# ─── Rolling window (Phase 3) ─────────────────────────────────────────────────

# Constants mirrored from transcription_service.py so tests don't import them.
_MIN_BUFFER_BYTES = 64_000


def make_audio_msg_of_size(n_bytes: int) -> dict:
    """Audio chunk whose decoded PCM is exactly n_bytes long."""
    return make_audio_msg(b"\x00\x01" * (n_bytes // 2))


class TestRollingWindow:
    @pytest.mark.asyncio
    async def test_no_transcription_below_threshold(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        # Send just under the threshold
        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES - 2))

        pool.transcribe.assert_not_called()

    @pytest.mark.asyncio
    async def test_transcription_triggers_at_threshold(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))

        pool.transcribe.assert_called_once()

    @pytest.mark.asyncio
    async def test_partial_transcript_emitted_with_is_final_false(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool("gedeeltelijk"), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))

        msgs = sent_messages(ws)
        assert len(msgs) == 1
        assert msgs[0]["is_final"] is False
        assert msgs[0]["text"] == "gedeeltelijk"

    @pytest.mark.asyncio
    async def test_buffer_empty_after_rolling_window(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))

        assert len(store.get("s1").pcm_buffer) == 0

    @pytest.mark.asyncio
    async def test_multiple_rolling_windows_each_emit_partial(self):
        pool  = make_pool()
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        # Each chunk pushes the buffer past the threshold from a clean tail,
        # so we get one window per chunk once the first has fired.
        # Send enough for two full windows: threshold + tail + threshold
        chunk_size = _MIN_BUFFER_BYTES
        await svc.on_audio_chunk("s1", make_audio_msg_of_size(chunk_size))
        # Buffer now has _TAIL_OVERLAP_BYTES remaining
        # Send enough to push past threshold again
        await svc.on_audio_chunk("s1", make_audio_msg_of_size(chunk_size))

        assert pool.transcribe.call_count == 2
        msgs = sent_messages(ws)
        assert all(m["is_final"] is False for m in msgs)

    @pytest.mark.asyncio
    async def test_finalise_after_rolling_window_emits_empty_final(self):
        pool  = make_pool()
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        # Rolling window consumes the entire buffer
        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))
        assert pool.transcribe.call_count == 1

        # Finalise finds an empty buffer — emits empty final without calling pool
        await svc.finalise("s1")
        assert pool.transcribe.call_count == 1

        msgs = sent_messages(ws)
        assert msgs[0]["is_final"] is False
        assert msgs[1]["is_final"] is True
        assert msgs[1]["text"] == ""

    @pytest.mark.asyncio
    async def test_window_seq_increments_across_partial_and_final(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))
        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert msgs[0]["window_seq"] == 1
        assert msgs[1]["window_seq"] == 2

    @pytest.mark.asyncio
    async def test_rolling_window_does_not_fire_for_unknown_session(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)

        # No open_session — on_audio_chunk for an unregistered session
        # The store will silently ignore the append, so threshold never triggers
        await svc.on_audio_chunk("unknown", make_audio_msg_of_size(_MIN_BUFFER_BYTES))
        pool.transcribe.assert_not_called()