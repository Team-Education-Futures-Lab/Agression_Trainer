"""
Tests for StubTranscriptionPool.

Verifies the stub honours its documented contract: canned Dutch text,
full confidence, and correct pool property values.
"""

import pytest

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from stubs.stub_transcription_pool import StubTranscriptionPool


@pytest.fixture
def pool() -> StubTranscriptionPool:
    return StubTranscriptionPool()


# ─── transcribe ───────────────────────────────────────────────────────────────

class TestTranscribe:
    @pytest.mark.asyncio
    async def test_returns_transcript_segment(self, pool):
        result = await pool.transcribe(b"\x00" * 100, 16_000, "s1")
        assert result is not None

    @pytest.mark.asyncio
    async def test_returns_non_empty_text(self, pool):
        result = await pool.transcribe(b"\x00" * 100, 16_000, "s1")
        assert isinstance(result.text, str)
        assert len(result.text) > 0

    @pytest.mark.asyncio
    async def test_returns_full_confidence(self, pool):
        result = await pool.transcribe(b"\x00" * 100, 16_000, "s1")
        assert result.confidence == 1.0

    @pytest.mark.asyncio
    async def test_returns_same_text_regardless_of_pcm(self, pool):
        r1 = await pool.transcribe(b"\x00" * 32, 16_000, "s1")
        r2 = await pool.transcribe(b"\xFF" * 1024, 16_000, "s1")
        assert r1.text == r2.text

    @pytest.mark.asyncio
    async def test_accepts_any_session_id(self, pool):
        result = await pool.transcribe(b"\x00" * 100, 16_000, "arbitrary-session-id")
        assert result is not None

    @pytest.mark.asyncio
    async def test_accepts_empty_pcm_without_raising(self, pool):
        result = await pool.transcribe(b"", 16_000, "s1")
        assert result is not None


# ─── pool properties ──────────────────────────────────────────────────────────

class TestProperties:
    def test_worker_count_is_one(self, pool):
        assert pool.worker_count == 1

    def test_available_workers_is_one(self, pool):
        assert pool.available_workers == 1

    def test_device_is_cpu(self, pool):
        assert pool.device == "cpu"

    def test_worker_count_does_not_change_after_transcribe(self, pool):
        # Stub is synchronous — availability should be unchanged after use
        import asyncio
        asyncio.get_event_loop().run_until_complete(
            pool.transcribe(b"\x00" * 100, 16_000, "s1")
        )
        assert pool.worker_count == 1
        assert pool.available_workers == 1