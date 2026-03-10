"""
Tests for the FastAPI routes in main.py.

Uses FastAPI's TestClient (backed by httpx) for all endpoints.

The BehaviourAnalyserInterface is replaced with an AsyncMock so these tests
cover routing, auth, and wire format only — not analyser logic.
"""

import os
import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from interfaces import BehaviourResult, SignalSummary


# ─── Fixtures ─────────────────────────────────────────────────────────────────

API_KEY = "test-internal-key"
AUTH    = {"Authorization": f"Bearer {API_KEY}"}

STUB_RESULT = BehaviourResult(
    window_id        = "session-1:1",
    session_id       = "session-1",
    escalation_score = -0.2,
    dominant_emotion = "calm",
    confidence       = 1.0,
    signal_summary   = SignalSummary(
        voice_tension   = 0.5,
        speech_pace     = 3.2,
        hand_velocity   = 0.3,
        gaze_stability  = 0.7,
        open_palm_ratio = 0.6,
        notable_signals = ["stub_mode"],
    ),
)

# Minimal valid AnalysisWindow payload — frames and mfccs are empty because
# the stub ignores them; notable_features drives branching in stub tests.
MINIMAL_WINDOW = {
    "window_id":  "session-1:1",
    "session_id": "session-1",
    "frames":     [],
    "mfccs":      [],
    "transcript": "test transcript",
    "clip_metadata": {
        "clip_id":           "clip_01",
        "scenario_id":       "scenario_01",
        "transcript":        "clip dialogue",
        "notable_features":  [],
        "branch_conditions": [
            {"min_score": -1.0, "max_score": 1.01, "next_clip": None}
        ],
    },
}

CHALLENGING_WINDOW = {
    **MINIMAL_WINDOW,
    "clip_metadata": {
        **MINIMAL_WINDOW["clip_metadata"],
        "notable_features": ["raised_voice", "aggressive_posture"],
    },
}


def make_mock_analyser(result: BehaviourResult = STUB_RESULT) -> MagicMock:
    analyser         = MagicMock()
    analyser.analyse = AsyncMock(return_value=result)
    return analyser


@pytest.fixture
def client_and_analyser():
    """
    Returns (TestClient, mock_analyser) with the app wired to a controllable
    mock analyser. The _make_analyser factory is patched so no real
    implementation is ever instantiated.
    """
    mock_analyser = make_mock_analyser()

    with patch.dict(os.environ, {"INTERNAL_API_KEY": API_KEY, "BEHAVIOUR_ANALYSER": "stub"}):
        with patch("main._make_analyser", return_value=mock_analyser):
            from main import create_app
            app = create_app()

    return TestClient(app, raise_server_exceptions=True), mock_analyser


# ─── GET /evaluate/health ─────────────────────────────────────────────────────

class TestHealth:
    def test_returns_200_without_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.get("/evaluate/health")
        assert resp.status_code == 200

    def test_returns_ok_status(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.get("/evaluate/health").json()
        assert data["status"] == "ok"

    def test_returns_device(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.get("/evaluate/health").json()
        assert data["device"] == "cpu"


# ─── POST /evaluate/reset/{session_id} ───────────────────────────────────────

class TestReset:
    def test_returns_401_without_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.post("/evaluate/reset/s1")
        assert resp.status_code == 401

    def test_returns_401_with_wrong_key(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.post("/evaluate/reset/s1",
                           headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 401

    def test_returns_200_with_valid_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.post("/evaluate/reset/s1", headers=AUTH)
        assert resp.status_code == 200

    def test_returns_correct_body(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/reset/s1", headers=AUTH).json()
        assert data["session_id"] == "s1"
        assert data["status"] == "reset"

    def test_returns_200_for_any_session_id(self, client_and_analyser):
        # reset is a no-op — always 200 regardless of whether session exists
        client, _ = client_and_analyser
        resp = client.post("/evaluate/reset/nonexistent", headers=AUTH)
        assert resp.status_code == 200

    def test_session_id_reflected_in_response(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/reset/my-session-42", headers=AUTH).json()
        assert data["session_id"] == "my-session-42"


# ─── POST /evaluate/analyse ───────────────────────────────────────────────────

class TestAnalyse:
    def test_returns_401_without_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.post("/evaluate/analyse", json=MINIMAL_WINDOW)
        assert resp.status_code == 401

    def test_returns_401_with_wrong_key(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={"Authorization": "Bearer wrong"},
        )
        assert resp.status_code == 401

    def test_returns_200_with_valid_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH)
        assert resp.status_code == 200

    def test_delegates_to_analyser(self, client_and_analyser):
        client, analyser = client_and_analyser
        client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH)
        analyser.analyse.assert_called_once()

    def test_passes_correct_window_id(self, client_and_analyser):
        client, analyser = client_and_analyser
        client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH)
        window = analyser.analyse.call_args.args[0]
        assert window.window_id == "session-1:1"

    def test_passes_correct_session_id(self, client_and_analyser):
        client, analyser = client_and_analyser
        client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH)
        window = analyser.analyse.call_args.args[0]
        assert window.session_id == "session-1"

    def test_passes_transcript(self, client_and_analyser):
        client, analyser = client_and_analyser
        client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH)
        window = analyser.analyse.call_args.args[0]
        assert window.transcript == "test transcript"

    def test_passes_notable_features(self, client_and_analyser):
        client, analyser = client_and_analyser
        client.post("/evaluate/analyse", json=CHALLENGING_WINDOW, headers=AUTH)
        window = analyser.analyse.call_args.args[0]
        assert "raised_voice" in window.clip_metadata.notable_features
        assert "aggressive_posture" in window.clip_metadata.notable_features

    def test_response_contains_escalation_score(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "escalation_score" in data

    def test_response_contains_dominant_emotion(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "dominant_emotion" in data

    def test_response_contains_confidence(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "confidence" in data

    def test_response_contains_signal_summary(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "signal_summary" in data

    def test_signal_summary_shape(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        ss = data["signal_summary"]
        assert "voice_tension"   in ss
        assert "speech_pace"     in ss
        assert "hand_velocity"   in ss
        assert "gaze_stability"  in ss
        assert "open_palm_ratio" in ss
        assert "notable_signals" in ss

    def test_response_reflects_analyser_result(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert data["escalation_score"] == STUB_RESULT.escalation_score
        assert data["dominant_emotion"] == STUB_RESULT.dominant_emotion
        assert data["confidence"]       == STUB_RESULT.confidence

    def test_response_window_id_matches_request(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert data["window_id"] == MINIMAL_WINDOW["window_id"]

    def test_422_on_missing_required_field(self, client_and_analyser):
        client, _ = client_and_analyser
        bad_body = {k: v for k, v in MINIMAL_WINDOW.items() if k != "session_id"}
        resp = client.post("/evaluate/analyse", json=bad_body, headers=AUTH)
        assert resp.status_code == 422

    def test_422_on_missing_clip_metadata(self, client_and_analyser):
        client, _ = client_and_analyser
        bad_body = {k: v for k, v in MINIMAL_WINDOW.items() if k != "clip_metadata"}
        resp = client.post("/evaluate/analyse", json=bad_body, headers=AUTH)
        assert resp.status_code == 422
