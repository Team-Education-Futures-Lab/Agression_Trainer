"""
Tests for SessionStore.

Pure in-memory logic — no I/O, no async. All tests are synchronous.
"""

import pytest
from unittest.mock import MagicMock

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from session_store import SessionStore


def make_ws() -> MagicMock:
    """Minimal WebSocket stand-in — only the object identity matters here."""
    return MagicMock()


# ─── open / close ─────────────────────────────────────────────────────────────

class TestOpen:
    def test_open_registers_session(self):
        store = SessionStore()
        ws = make_ws()
        store.open("s1", ws)
        assert "s1" in store

    def test_open_returns_entry_with_correct_websocket(self):
        store = SessionStore()
        ws = make_ws()
        entry = store.open("s1", ws)
        assert entry.websocket is ws

    def test_open_initialises_empty_buffer(self):
        store = SessionStore()
        entry = store.open("s1", make_ws())
        assert len(entry.pcm_buffer) == 0

    def test_open_initialises_window_seq_to_zero(self):
        store = SessionStore()
        entry = store.open("s1", make_ws())
        assert entry.window_seq == 0

    def test_open_replaces_stale_entry_for_same_session(self):
        store = SessionStore()
        ws1 = make_ws()
        ws2 = make_ws()
        store.open("s1", ws1)
        entry = store.open("s1", ws2)
        assert entry.websocket is ws2
        assert store.get("s1").websocket is ws2


class TestClose:
    def test_close_removes_session(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.close("s1")
        assert "s1" not in store

    def test_close_unknown_session_does_not_raise(self):
        store = SessionStore()
        store.close("unknown")  # should not raise

    def test_get_returns_none_after_close(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.close("s1")
        assert store.get("s1") is None


# ─── get ──────────────────────────────────────────────────────────────────────

class TestGet:
    def test_get_returns_entry_for_known_session(self):
        store = SessionStore()
        ws = make_ws()
        store.open("s1", ws)
        entry = store.get("s1")
        assert entry is not None
        assert entry.websocket is ws

    def test_get_returns_none_for_unknown_session(self):
        store = SessionStore()
        assert store.get("unknown") is None

    def test_get_is_isolated_per_session(self):
        store = SessionStore()
        ws1, ws2 = make_ws(), make_ws()
        store.open("s1", ws1)
        store.open("s2", ws2)
        assert store.get("s1").websocket is ws1
        assert store.get("s2").websocket is ws2


# ─── reset ────────────────────────────────────────────────────────────────────

class TestReset:
    def test_reset_clears_pcm_buffer(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.append_pcm("s1", b"\x00\x01\x02\x03")
        store.reset("s1")
        assert len(store.get("s1").pcm_buffer) == 0

    def test_reset_resets_window_seq_to_zero(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.next_seq("s1")
        store.next_seq("s1")
        store.reset("s1")
        assert store.get("s1").window_seq == 0

    def test_reset_does_not_remove_session(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.reset("s1")
        assert "s1" in store

    def test_reset_preserves_websocket_reference(self):
        store = SessionStore()
        ws = make_ws()
        store.open("s1", ws)
        store.reset("s1")
        assert store.get("s1").websocket is ws

    def test_reset_unknown_session_does_not_raise(self):
        store = SessionStore()
        store.reset("unknown")  # should not raise


# ─── append_pcm ───────────────────────────────────────────────────────────────

class TestAppendPcm:
    def test_appends_bytes_to_buffer(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.append_pcm("s1", b"\x01\x02")
        store.append_pcm("s1", b"\x03\x04")
        assert bytes(store.get("s1").pcm_buffer) == b"\x01\x02\x03\x04"

    def test_append_to_unknown_session_does_not_raise(self):
        store = SessionStore()
        store.append_pcm("unknown", b"\x00\x01")  # should not raise

    def test_multiple_sessions_have_independent_buffers(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.open("s2", make_ws())
        store.append_pcm("s1", b"\xAA")
        store.append_pcm("s2", b"\xBB")
        assert bytes(store.get("s1").pcm_buffer) == b"\xAA"
        assert bytes(store.get("s2").pcm_buffer) == b"\xBB"


# ─── next_seq ─────────────────────────────────────────────────────────────────

class TestNextSeq:
    def test_first_call_returns_one(self):
        store = SessionStore()
        store.open("s1", make_ws())
        assert store.next_seq("s1") == 1

    def test_increments_monotonically(self):
        store = SessionStore()
        store.open("s1", make_ws())
        seqs = [store.next_seq("s1") for _ in range(5)]
        assert seqs == [1, 2, 3, 4, 5]

    def test_unknown_session_returns_zero(self):
        store = SessionStore()
        assert store.next_seq("unknown") == 0

    def test_seq_is_independent_per_session(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.open("s2", make_ws())
        store.next_seq("s1")
        store.next_seq("s1")
        store.next_seq("s2")
        assert store.get("s1").window_seq == 2
        assert store.get("s2").window_seq == 1

    def test_seq_resets_to_one_after_store_reset(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.next_seq("s1")
        store.next_seq("s1")
        store.reset("s1")
        assert store.next_seq("s1") == 1


# ─── __contains__ ─────────────────────────────────────────────────────────────

class TestContains:
    def test_contains_true_for_open_session(self):
        store = SessionStore()
        store.open("s1", make_ws())
        assert "s1" in store

    def test_contains_false_for_unknown_session(self):
        store = SessionStore()
        assert "unknown" not in store

    def test_contains_false_after_close(self):
        store = SessionStore()
        store.open("s1", make_ws())
        store.close("s1")
        assert "s1" not in store