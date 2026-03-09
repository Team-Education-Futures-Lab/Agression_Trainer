"""
Tests for the FastAPI routes in main.py.

Uses FastAPI's TestClient (backed by httpx) for HTTP endpoints and
starlette's WebSocket test session for the WebSocket endpoint.

The TranscriptionService is replaced with an AsyncMock so these tests
cover routing, auth, and wire format only — not service logic.
"""

import base64
import json
import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))


# ─── App fixture ──────────────────────────────────────────────────────────────
#
# We patch TranscriptionService before importing create_app so the real
# service (and pool) are never instantiated during tests.
# ─────────────────────────────────────────────────────────────────────────────

API_KEY = "test-internal-key"
AUTH    = {"Authorization": f"Bearer {API_KEY}"}


def make_mock_service() -> MagicMock:
    svc = MagicMock()
    svc.open_session  = MagicMock()
    svc.close_session = MagicMock()
    svc.reset_session = MagicMock()
    svc.on_audio_chunk = AsyncMock()
    svc.finalise       = AsyncMock(return_value=True)
    return svc


def make_mock_pool() -> MagicMock:
    pool = MagicMock()
    pool.worker_count     = 2
    pool.available_workers = 2
    pool.device           = "cpu"
    return pool


@pytest.fixture
def client_and_service():
    """
    Returns (TestClient, mock_service) with the app wired to a stub pool
    and a controllable mock service.
    """
    mock_svc  = make_mock_service()
    mock_pool = make_mock_pool()

    with patch.dict(os.environ, {"INTERNAL_API_KEY": API_KEY, "TRANSCRIPTION_POOL": "stub"}):
        with patch("main.TranscriptionService", return_value=mock_svc), \
             patch("main._make_pool",           return_value=mock_pool):
            from main import create_app
            app = create_app()

    return TestClient(app, raise_server_exceptions=True), mock_svc, mock_pool


# ─── /transcription/health ────────────────────────────────────────────────────

class TestHealth:
    def test_returns_200_without_auth(self, client_and_service):
        client, _, pool = client_and_service
        resp = client.get("/transcription/health")
        assert resp.status_code == 200

    def test_returns_ok_status(self, client_and_service):
        client, _, _ = client_and_service
        data = client.get("/transcription/health").json()
        assert data["status"] == "ok"

    def test_returns_worker_counts(self, client_and_service):
        client, _, _ = client_and_service
        data = client.get("/transcription/health").json()
        assert data["whisper_workers"]["total"]     == 2
        assert data["whisper_workers"]["available"] == 2

    def test_returns_device(self, client_and_service):
        client, _, _ = client_and_service
        data = client.get("/transcription/health").json()
        assert data["device"] == "cpu"


# ─── POST /transcription/finalise/{session_id} ────────────────────────────────

class TestFinalise:
    def test_returns_401_without_auth(self, client_and_service):
        client, _, _ = client_and_service
        resp = client.post("/transcription/finalise/s1")
        assert resp.status_code == 401

    def test_returns_401_with_wrong_key(self, client_and_service):
        client, _, _ = client_and_service
        resp = client.post("/transcription/finalise/s1",
                           headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 401

    def test_returns_200_for_known_session(self, client_and_service):
        client, svc, _ = client_and_service
        svc.finalise = AsyncMock(return_value=True)
        resp = client.post("/transcription/finalise/s1", headers=AUTH)
        assert resp.status_code == 200

    def test_returns_correct_body_on_success(self, client_and_service):
        client, svc, _ = client_and_service
        svc.finalise = AsyncMock(return_value=True)
        data = client.post("/transcription/finalise/s1", headers=AUTH).json()
        assert data["session_id"] == "s1"
        assert data["status"] == "finalised"

    def test_returns_404_for_unknown_session(self, client_and_service):
        client, svc, _ = client_and_service
        svc.finalise = AsyncMock(return_value=False)
        resp = client.post("/transcription/finalise/unknown", headers=AUTH)
        assert resp.status_code == 404

    def test_calls_service_finalise_with_session_id(self, client_and_service):
        client, svc, _ = client_and_service
        svc.finalise = AsyncMock(return_value=True)
        client.post("/transcription/finalise/s42", headers=AUTH)
        svc.finalise.assert_called_once_with("s42")


# ─── POST /transcription/reset/{session_id} ───────────────────────────────────

class TestReset:
    def test_returns_401_without_auth(self, client_and_service):
        client, _, _ = client_and_service
        resp = client.post("/transcription/reset/s1")
        assert resp.status_code == 401

    def test_returns_200_with_valid_auth(self, client_and_service):
        client, _, _ = client_and_service
        resp = client.post("/transcription/reset/s1", headers=AUTH)
        assert resp.status_code == 200

    def test_returns_correct_body(self, client_and_service):
        client, _, _ = client_and_service
        data = client.post("/transcription/reset/s1", headers=AUTH).json()
        assert data["session_id"] == "s1"
        assert data["status"] == "reset"

    def test_calls_service_reset_with_session_id(self, client_and_service):
        client, svc, _ = client_and_service
        client.post("/transcription/reset/s99", headers=AUTH)
        svc.reset_session.assert_called_once_with("s99")

    def test_reset_unknown_session_still_returns_200(self, client_and_service):
        # reset is a best-effort clear — it should not 404
        client, _, _ = client_and_service
        resp = client.post("/transcription/reset/nonexistent", headers=AUTH)
        assert resp.status_code == 200


# ─── WebSocket /ws/{session_id} ───────────────────────────────────────────────

class TestWebSocket:
    def test_rejects_missing_auth_with_close(self, client_and_service):
        client, _, _ = client_and_service
        with pytest.raises(Exception):
            # TestClient raises when the server closes before accept()
            with client.websocket_connect("/ws/s1"):
                pass

    def test_accepts_valid_auth(self, client_and_service):
        client, _, _ = client_and_service
        with client.websocket_connect("/ws/s1", headers=AUTH) as ws:
            # Connection should be accepted — no exception raised
            assert ws is not None

    def test_calls_open_session_on_connect(self, client_and_service):
        client, svc, _ = client_and_service
        with client.websocket_connect("/ws/s1", headers=AUTH):
            svc.open_session.assert_called_once()
            call_args = svc.open_session.call_args
            assert call_args.args[0] == "s1"

    def test_calls_close_session_on_disconnect(self, client_and_service):
        client, svc, _ = client_and_service
        with client.websocket_connect("/ws/s1", headers=AUTH):
            pass  # exit context triggers disconnect
        svc.close_session.assert_called_once_with("s1")

    def test_routes_audio_chunk_to_service(self, client_and_service):
        client, svc, _ = client_and_service
        msg = {
            "type":        "audio_chunk",
            "session_id":  "s1",
            "chunk_id":    1,
            "timestamp":   0.0,
            "pcm":         base64.b64encode(b"\x00" * 64).decode(),
            "sample_rate": 16_000,
            "mfccs":       [],
        }
        with client.websocket_connect("/ws/s1", headers=AUTH) as ws:
            ws.send_text(json.dumps(msg))

        svc.on_audio_chunk.assert_called_once()
        call_session_id = svc.on_audio_chunk.call_args.args[0]
        assert call_session_id == "s1"

    def test_ignores_unknown_message_type_without_closing(self, client_and_service):
        client, svc, _ = client_and_service
        with client.websocket_connect("/ws/s1", headers=AUTH) as ws:
            ws.send_text(json.dumps({"type": "unknown_type"}))
            # Connection should remain open — service should not be called
        svc.on_audio_chunk.assert_not_called()

    def test_ignores_malformed_json_without_closing(self, client_and_service):
        client, _, _ = client_and_service
        with client.websocket_connect("/ws/s1", headers=AUTH) as ws:
            ws.send_text("this is not json{{")
            # Connection should remain open without raising

    def test_multiple_audio_chunks_all_routed(self, client_and_service):
        client, svc, _ = client_and_service
        msg = {
            "type":        "audio_chunk",
            "session_id":  "s1",
            "chunk_id":    0,
            "timestamp":   0.0,
            "pcm":         base64.b64encode(b"\x00" * 64).decode(),
            "sample_rate": 16_000,
            "mfccs":       [],
        }
        with client.websocket_connect("/ws/s1", headers=AUTH) as ws:
            for i in range(5):
                ws.send_text(json.dumps({**msg, "chunk_id": i}))

        assert svc.on_audio_chunk.call_count == 5