"""
Tests for TranscriptionService.

The pool and WebSocket are both mocked so these tests cover orchestration
logic only — buffer management, Whisper dispatch, and Transcript emission —
without any real I/O or inference.
"""

import base64
import json
import math
import struct
import pytest
from unittest.mock import AsyncMock, MagicMock

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from interfaces import TranscriptSegment, WordTiming
from session_store import SessionStore, BYTES_PER_SECOND
from transcription_service import TranscriptionService, _OVERLAP_WORDS
from whisper_pool import TranscriptionError


# ─── Helpers ──────────────────────────────────────────────────────────────────

def make_pool(
    text:       str   = "hallo wereld",
    confidence: float = 0.9,
    words:      list  = None,
) -> MagicMock:
    """Mock pool that resolves transcribe() with a fixed TranscriptSegment."""
    pool = MagicMock()
    pool.transcribe = AsyncMock(return_value=TranscriptSegment(
        text       = text,
        confidence = confidence,
        words      = words or [],
    ))
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


def make_speech_pcm(n_bytes: int) -> bytes:
    """
    Generate s16le PCM bytes whose RMS is well above the silence threshold.
    Uses a simple sine-like pattern with amplitude ~8000 (well above 200).
    """
    n_samples = n_bytes // 2
    samples = []
    for i in range(n_samples):
        samples.append(8000 if i % 2 == 0 else -8000)
    return struct.pack(f"<{n_samples}h", *samples)


def make_silent_pcm(n_bytes: int) -> bytes:
    """Generate s16le PCM bytes that are all-zero (RMS = 0, always silent)."""
    return b"\x00" * n_bytes


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
        svc.close_session("unknown")

    def test_reset_clears_buffer_but_keeps_session(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())
        store.append_pcm("s1", b"\x00" * 200)
        svc.reset_session("s1")
        assert "s1" in store
        assert len(store.get("s1").pcm_buffer) == 0

    def test_reset_clears_overlap_state(self):
        """reset_session must clear overlap_pcm, overlap_session_start, emitted_until."""
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())
        entry = store.get("s1")
        entry.overlap_pcm           = b"\x01\x02\x03\x04"
        entry.overlap_session_start = 3.5
        entry.emitted_until         = 4.2
        svc.reset_session("s1")
        entry = store.get("s1")
        assert entry.overlap_pcm           == b""
        assert entry.overlap_session_start == 0.0
        assert entry.emitted_until         == 0.0


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
        await svc.on_audio_chunk("s1", {"type": "audio_chunk"})

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

        pcm = make_speech_pcm(100)
        await svc.on_audio_chunk("s1", make_audio_msg(pcm))
        await svc.finalise("s1")

        pool.transcribe.assert_called_once()
        call_pcm = pool.transcribe.call_args.kwargs["pcm"]
        # No prior overlap, so pool receives exactly the new pcm.
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
        # Supply a word so _dispatch_to_pool has something to emit.
        # start=0.1, end=0.5 fits inside make_speech_pcm(100) = 200 bytes (0.00625 s).
        # The word end=0.5 is beyond the buffer duration but overlap byte offset
        # is clamped to len(combined), so this is safe — the test only checks
        # that the word is emitted, not overlap sizing.
        w     = WordTiming(word="hallo", start=0.0, end=0.1)
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool("hallo", words=[w]), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
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

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert msgs[0]["confidence"] == pytest.approx(0.75)

    @pytest.mark.asyncio
    async def test_transcript_message_contains_words_field(self):
        """All emitted transcript messages must include a words list."""
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert "words" in msgs[0]
        assert isinstance(msgs[0]["words"], list)

    @pytest.mark.asyncio
    async def test_words_empty_when_pool_returns_no_timings(self):
        """When the pool returns no word timings, words field is empty list."""
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool("hallo", words=[]), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

        msgs = sent_messages(ws)
        assert msgs[0]["words"] == []

    @pytest.mark.asyncio
    async def test_words_at_session_level_when_no_prior_overlap(self):
        """
        When overlap_session_start=0.0 (first window), session-level times
        equal pool-relative times exactly.
        """
        w = WordTiming(word="hallo", start=0.5, end=1.0)
        pool  = make_pool("hallo", words=[w])
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

        msgs = sent_messages(ws)
        emitted_words = msgs[0]["words"]
        assert len(emitted_words) == 1
        assert emitted_words[0]["word"] == "hallo"
        assert emitted_words[0]["start"] == pytest.approx(0.5)
        assert emitted_words[0]["end"]   == pytest.approx(1.0)

    @pytest.mark.asyncio
    async def test_window_seq_starts_at_one_per_connection(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)

        ws1 = make_ws()
        svc.open_session("s1", ws1)
        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")
        svc.close_session("s1")

        ws2 = make_ws()
        svc.open_session("s1", ws2)
        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

        assert sent_messages(ws1)[0]["window_seq"] == 1
        assert sent_messages(ws2)[0]["window_seq"] == 1

    @pytest.mark.asyncio
    async def test_window_seq_increments_within_one_connection(self):
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)
        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=True)

        msgs = sent_messages(ws)
        assert msgs[0]["window_seq"] == 1
        assert msgs[1]["window_seq"] == 2

    @pytest.mark.asyncio
    async def test_clears_buffer_after_dispatch(self):
        store = SessionStore()
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

        assert len(store.get("s1").pcm_buffer) == 0

    @pytest.mark.asyncio
    async def test_second_finalise_does_not_call_pool_again(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")
        await svc.finalise("s1")

        assert pool.transcribe.call_count == 1

    @pytest.mark.asyncio
    async def test_send_failure_does_not_propagate(self):
        store = SessionStore()
        ws    = make_ws()
        ws.send_text = AsyncMock(side_effect=Exception("connection lost"))
        svc   = TranscriptionService(make_pool(), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

    @pytest.mark.asyncio
    async def test_whisper_error_in_finalise_does_not_propagate(self):
        pool  = make_pool()
        pool.transcribe = AsyncMock(side_effect=TranscriptionError("model OOM"))
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        result = await svc.finalise("s1")

        assert result is True
        msgs = sent_messages(ws)
        assert len(msgs) == 1
        assert msgs[0]["is_final"] is True
        assert msgs[0]["text"] == ""
        assert msgs[0]["words"] == []

    @pytest.mark.asyncio
    async def test_finalise_clears_overlap_pcm(self):
        """After finalise(), overlap_pcm must be empty."""
        words = [WordTiming(word="hallo", start=0.5, end=1.0)]
        pool  = make_pool("hallo", words=words)
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg(make_speech_pcm(100)))
        await svc.finalise("s1")

        entry = store.get("s1")
        assert entry.overlap_pcm == b""


# ─── Rolling window ───────────────────────────────────────────────────────────

_MIN_BUFFER_BYTES = 192_000


def make_audio_msg_of_size(n_bytes: int, silent: bool = False) -> dict:
    pcm = make_silent_pcm(n_bytes) if silent else make_speech_pcm(n_bytes)
    return make_audio_msg(pcm)


class TestRollingWindow:
    @pytest.mark.asyncio
    async def test_no_transcription_below_threshold(self):
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

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
        w     = WordTiming(word="gedeeltelijk", start=0.0, end=0.5)
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(make_pool("gedeeltelijk", words=[w]), store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))

        msgs = sent_messages(ws)
        assert len(msgs) == 1
        assert msgs[0]["is_final"] is False
        assert msgs[0]["text"] == "gedeeltelijk"
        assert "words" in msgs[0]

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

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))
        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))

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

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES))
        assert pool.transcribe.call_count == 1

        await svc.finalise("s1")
        assert pool.transcribe.call_count == 1

        msgs = sent_messages(ws)
        assert msgs[0]["is_final"] is False
        assert msgs[1]["is_final"] is True
        assert msgs[1]["text"] == ""
        assert msgs[1]["words"] == []

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

        await svc.on_audio_chunk("unknown", make_audio_msg_of_size(_MIN_BUFFER_BYTES))
        pool.transcribe.assert_not_called()

    @pytest.mark.asyncio
    async def test_whisker_error_in_rolling_window_does_not_propagate(self):
        pool  = make_pool()
        pool.transcribe = AsyncMock(side_effect=TranscriptionError("model OOM"))
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        await svc._transcribe_window("s1", is_final=False)

    @pytest.mark.asyncio
    async def test_silent_buffer_does_not_call_pool(self):
        pool  = make_pool()
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        await svc.on_audio_chunk("s1", make_audio_msg_of_size(_MIN_BUFFER_BYTES, silent=True))

        pool.transcribe.assert_not_called()
        assert len(sent_messages(ws)) == 0


# ─── Overlap-window behaviour ─────────────────────────────────────────────────

class TestOverlapWindow:
    @pytest.mark.asyncio
    async def test_overlap_pcm_set_after_first_window(self):
        """
        After the first window fires with a non-empty word list,
        overlap_pcm must be non-empty.

        PCM must be at least overlap_start_word.start * BYTES_PER_SECOND bytes.
        overlap_start_word = words[-3] = twee at start=0.4 s
        → need > 0.4 * 32000 = 12800 bytes. We use 32000 (1 s of audio).
        """
        words = [
            WordTiming(word="een",  start=0.0, end=0.3),
            WordTiming(word="twee", start=0.4, end=0.7),
            WordTiming(word="drie", start=0.8, end=1.1),
            WordTiming(word="vier", start=1.2, end=1.5),
        ]
        pool  = make_pool("een twee drie vier", words=words)
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        pcm = make_speech_pcm(32_000)   # 1 s of audio; fits all word timestamps
        store.append_pcm("s1", pcm)
        await svc._transcribe_window("s1", is_final=False)

        entry = store.get("s1")
        assert entry.overlap_pcm != b""

    @pytest.mark.asyncio
    async def test_overlap_pcm_empty_after_reset(self):
        """reset_session must clear overlap_pcm."""
        words = [WordTiming(word="hallo", start=0.0, end=0.5)]
        pool  = make_pool("hallo", words=words)
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        pcm = make_speech_pcm(64)
        store.append_pcm("s1", pcm)
        await svc._transcribe_window("s1", is_final=False)

        svc.reset_session("s1")
        assert store.get("s1").overlap_pcm == b""

    @pytest.mark.asyncio
    async def test_second_window_receives_overlap_prepended(self):
        """
        The PCM bytes sent to the pool on the second window must begin with
        the overlap bytes stored after the first window.

        PCM must be large enough that the overlap byte offset fits within it.
        overlap_start_word = words[-3] = twee at start=0.4 s
        → need > 12800 bytes. We use 32000 (1 s).
        """
        words_w1 = [
            WordTiming(word="een",  start=0.0, end=0.3),
            WordTiming(word="twee", start=0.4, end=0.7),
            WordTiming(word="drie", start=0.8, end=1.1),
            WordTiming(word="vier", start=1.2, end=1.5),
        ]
        pcm1 = make_speech_pcm(32_000)   # 1 s
        pcm2 = make_speech_pcm(32_000)

        pool  = MagicMock()
        pool.transcribe = AsyncMock(side_effect=[
            TranscriptSegment(text="een twee drie vier", confidence=0.9, words=words_w1),
            TranscriptSegment(text="vijf", confidence=0.9, words=[
                WordTiming(word="vijf", start=2.0, end=2.4),
            ]),
        ])
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        # First window
        store.append_pcm("s1", pcm1)
        await svc._transcribe_window("s1", is_final=False)

        entry = store.get("s1")
        saved_overlap = entry.overlap_pcm
        assert len(saved_overlap) > 0

        # Second window
        store.append_pcm("s1", pcm2)
        await svc._transcribe_window("s1", is_final=False)

        second_call_pcm = pool.transcribe.call_args_list[1].kwargs["pcm"]
        assert second_call_pcm[:len(saved_overlap)] == saved_overlap
        assert second_call_pcm[len(saved_overlap):] == pcm2

    @pytest.mark.asyncio
    async def test_overlap_words_filtered_from_second_emission(self):
        """
        Words whose session-level end <= emitted_until must not appear in
        the second window's emitted words.
        """
        # Window 1 emits words ending at 1.5; overlap covers the last 3 words
        # (twee, drie, vier: ends at 0.7, 1.1, 1.5). emitted_until = 1.5.
        words_w1 = [
            WordTiming(word="een",  start=0.0, end=0.3),
            WordTiming(word="twee", start=0.4, end=0.7),
            WordTiming(word="drie", start=0.8, end=1.1),
            WordTiming(word="vier", start=1.2, end=1.5),
        ]
        # Window 2 pool returns words; the overlap region is included at the
        # start. We simulate by having the overlap words returned at their
        # original pool-relative positions (which, after offset, become
        # session times <= emitted_until) plus a new word.
        # overlap_session_start will be set to the start of the 2nd-to-last
        # _OVERLAP_WORDS word = words_w1[-3].start = 0.4 (session-level).
        # So pool-relative word times for window 2 represent session =
        # pool_rel + overlap_session_start.
        # Overlap words (twee=0.4..0.7, drie=0.8..1.1, vier=1.2..1.5)
        # in pool-relative coords: subtract overlap_session_start (0.4):
        # twee: 0.0..0.3, drie: 0.4..0.7, vier: 0.8..1.1
        # New word vijf at pool-relative 1.2..1.6 → session 1.6..2.0
        words_w2_pool_rel = [
            WordTiming(word="twee", start=0.0, end=0.3),
            WordTiming(word="drie", start=0.4, end=0.7),
            WordTiming(word="vier", start=0.8, end=1.1),
            WordTiming(word="vijf", start=1.2, end=1.6),
        ]

        pool  = MagicMock()
        pool.transcribe = AsyncMock(side_effect=[
            TranscriptSegment(text="een twee drie vier", confidence=0.9, words=words_w1),
            TranscriptSegment(text="twee drie vier vijf", confidence=0.9, words=words_w2_pool_rel),
        ])
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        msgs = sent_messages(ws)
        # Window 2 must emit only "vijf", not the overlap words.
        w2_words = msgs[1]["words"]
        assert len(w2_words) == 1
        assert w2_words[0]["word"] == "vijf"

    @pytest.mark.asyncio
    async def test_emitted_until_advances_after_each_window(self):
        """emitted_until must equal the session-level end of the last new word."""
        words = [
            WordTiming(word="een",  start=0.0, end=0.3),
            WordTiming(word="twee", start=0.4, end=0.7),
        ]
        pool  = make_pool("een twee", words=words)
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        entry = store.get("s1")
        # session-level end of "twee" = overlap_session_start(0.0) + 0.7 = 0.7
        assert entry.emitted_until == pytest.approx(0.7)

    @pytest.mark.asyncio
    async def test_overlap_state_unchanged_when_pool_returns_no_words(self):
        """
        When the pool returns an empty word list, overlap_pcm and
        emitted_until must not change.
        """
        words_w1 = [WordTiming(word="hallo", start=0.0, end=0.5)]
        pool  = MagicMock()
        pool.transcribe = AsyncMock(side_effect=[
            TranscriptSegment(text="hallo", confidence=0.9, words=words_w1),
            TranscriptSegment(text="",      confidence=0.9, words=[]),
        ])
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        entry = store.get("s1")
        overlap_after_w1  = entry.overlap_pcm
        emitted_after_w1  = entry.emitted_until

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        entry = store.get("s1")
        assert entry.overlap_pcm  == overlap_after_w1
        assert entry.emitted_until == emitted_after_w1

    @pytest.mark.asyncio
    async def test_new_words_emitted_with_session_level_offset(self):
        """
        When overlap_session_start > 0, new word times must be
        pool_relative + overlap_session_start.
        """
        # Window 1: two words, overlap = last _OVERLAP_WORDS = 3 but only 2
        # available, so overlap starts from words[0].
        words_w1 = [
            WordTiming(word="een",  start=0.0, end=0.5),
            WordTiming(word="twee", start=0.6, end=1.0),
        ]
        # After w1: emitted_until = 1.0, overlap_session_start = 0.0 (words[0].start).
        # New word in window 2 at pool-relative 1.2..1.8.
        # Session-level = 1.2 + 0.0 = 1.2 (overlap_session_start is still 0.0
        # because we had fewer than _OVERLAP_WORDS, so overlap starts from words[0])
        # Actually with 2 words < _OVERLAP_WORDS(3), overlap_start_word = words[0]
        # → overlap_session_start = 0.0; so w2 pool-relative offsets:
        # overlap region ends at session time 1.0; pool returns twee at
        # 0.6..1.0 (pool-relative, since overlap_session_start=0.0) and vijf at 1.2..1.8.
        words_w2_pool_rel = [
            WordTiming(word="twee", start=0.6, end=1.0),
            WordTiming(word="vijf", start=1.2, end=1.8),
        ]

        pool  = MagicMock()
        pool.transcribe = AsyncMock(side_effect=[
            TranscriptSegment(text="een twee", confidence=0.9, words=words_w1),
            TranscriptSegment(text="twee vijf", confidence=0.9, words=words_w2_pool_rel),
        ])
        store = SessionStore()
        ws    = make_ws()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", ws)

        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)
        store.append_pcm("s1", make_speech_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        msgs = sent_messages(ws)
        w2_words = msgs[1]["words"]
        # "twee" is in overlap (session end 1.0 == emitted_until 1.0, NOT > so filtered).
        # "vijf" session end = 0.0 + 1.8 = 1.8 > 1.0 → emitted.
        assert len(w2_words) == 1
        assert w2_words[0]["word"] == "vijf"
        assert w2_words[0]["start"] == pytest.approx(1.2)
        assert w2_words[0]["end"]   == pytest.approx(1.8)

    @pytest.mark.asyncio
    async def test_silence_gate_still_prevents_pool_dispatch(self):
        """Silent windows must not call the pool even with overlap."""
        pool  = make_pool()
        store = SessionStore()
        svc   = TranscriptionService(pool, store)
        svc.open_session("s1", make_ws())

        store.append_pcm("s1", make_silent_pcm(64))
        await svc._transcribe_window("s1", is_final=False)

        pool.transcribe.assert_not_called()