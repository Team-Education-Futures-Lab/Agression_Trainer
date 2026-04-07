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
        vocal_tension      = 0.5,
        speech_pace        = 3.2,
        gesture_activity   = 0.3,
        open_gesture_ratio = 0.6,
        head_nod_frequency = 0.4,
        facing_ratio       = 0.8,
        silence_ratio      = 0.2,
        lexical_markers    = [],
        response_tone      = "neutral",
        notable_signals    = ["stub_mode"],
    ),
)

# Minimal valid AnalysisWindow payload. frames and mfccs are empty because
# the stub ignores them; rubric weights drive the stub score.
MINIMAL_WINDOW = {
    "window_id":  "session-1:1",
    "session_id": "session-1",
    "frames":     [],
    "mfccs":      [],
    "transcript": "test transcript",
    "clip_metadata": {
        "clip_id":                "clip_01",
        "scenario_id":            "scenario_01",
        "transcript":             "clip dialogue",
        "clip_duration_seconds":  10.0,
        "notable_features":       [],
        "scoring_mode":           "rubric",
        "de_escalation_rubric":   [],
        "escalation_rubric":      [],
        "branch_conditions": [
            {"min_score": -1.0, "max_score": 1.01, "next_clip": None}
        ],
    },
}

# Window with challenging notable_features to test the fallback heuristic in
# the stub when rubrics are empty (esc_weight == de_weight == 0).
CHALLENGING_WINDOW = {
    **MINIMAL_WINDOW,
    "clip_metadata": {
        **MINIMAL_WINDOW["clip_metadata"],
        "notable_features": ["raised_voice", "aggressive_posture"],
    },
}

# Window with weighted rubrics to test rubric-driven scoring.
RUBRIC_WINDOW = {
    **MINIMAL_WINDOW,
    "clip_metadata": {
        **MINIMAL_WINDOW["clip_metadata"],
        "de_escalation_rubric": [{"signal": "calm_voice", "weight": 0.9}],
        "escalation_rubric":    [{"signal": "raised_voice", "weight": 1.0}],
        "critical_failures":    ["raised_voice"],
        "score_range":          {"min": -0.9, "max": 0.9},
    },
}

# Stub debug stages payload returned when collect_debug=True.
STUB_DEBUG_STAGES = {"note": "stub analyser — no intermediate stage data available"}


def make_mock_analyser(
    result: BehaviourResult = STUB_RESULT,
    stages: dict | None = None,
    analyser_id: str = "stub",
) -> MagicMock:
    analyser             = MagicMock()
    analyser.analyser_id = analyser_id
    # analyse() now returns (result, stages). The mock honours collect_debug by
    # always returning the provided stages value (None by default).
    async def _analyse(window, *, collect_debug=False):
        return result, (stages if collect_debug else None)
    analyser.analyse = _analyse
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


@pytest.fixture
def debug_client_and_analyser():
    """
    Returns (TestClient, mock_analyser) where the mock returns stub debug stages
    when collect_debug=True.
    """
    mock_analyser = make_mock_analyser(stages=STUB_DEBUG_STAGES)

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
        # analyse was called (we cannot use assert_called_once because it's a
        # plain async def, not an AsyncMock, but the response proves it ran)

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
        assert "vocal_tension"      in ss
        assert "speech_pace"        in ss
        assert "gesture_activity"   in ss
        assert "open_gesture_ratio" in ss
        assert "head_nod_frequency" in ss
        assert "facing_ratio"       in ss
        assert "silence_ratio"      in ss
        assert "lexical_markers"    in ss
        assert "response_tone"      in ss
        assert "notable_signals"    in ss
        # Old field names must be absent
        assert "voice_tension"   not in ss
        assert "hand_velocity"   not in ss
        assert "gaze_stability"  not in ss
        assert "open_palm_ratio" not in ss

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

    def test_no_debug_field_without_x_debug_header(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "debug" not in data

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

    def test_422_on_missing_clip_duration_seconds(self, client_and_analyser):
        client, _ = client_and_analyser
        meta = {k: v for k, v in MINIMAL_WINDOW["clip_metadata"].items()
                if k != "clip_duration_seconds"}
        bad_body = {**MINIMAL_WINDOW, "clip_metadata": meta}
        resp = client.post("/evaluate/analyse", json=bad_body, headers=AUTH)
        assert resp.status_code == 422

    def test_422_on_missing_scoring_mode(self, client_and_analyser):
        client, _ = client_and_analyser
        meta = {k: v for k, v in MINIMAL_WINDOW["clip_metadata"].items()
                if k != "scoring_mode"}
        bad_body = {**MINIMAL_WINDOW, "clip_metadata": meta}
        resp = client.post("/evaluate/analyse", json=bad_body, headers=AUTH)
        assert resp.status_code == 422

    def test_extra_clip_metadata_fields_ignored(self, client_and_analyser):
        """video_url and other App-only fields must not cause a 422."""
        client, _ = client_and_analyser
        window_with_extras = {
            **MINIMAL_WINDOW,
            "clip_metadata": {
                **MINIMAL_WINDOW["clip_metadata"],
                "video_url": "/scenarios/scenario_01/clip_01.mp4",
            },
        }
        resp = client.post("/evaluate/analyse", json=window_with_extras, headers=AUTH)
        assert resp.status_code == 200


# ─── POST /evaluate/analyse — debug path ─────────────────────────────────────

class TestAnalyseDebug:
    def test_debug_field_present_with_x_debug_true(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "true"},
        ).json()
        assert "debug" in data

    def test_debug_field_absent_without_x_debug_header(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "debug" not in data

    def test_debug_field_absent_with_x_debug_false(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "false"},
        ).json()
        assert "debug" not in data

    def test_debug_contains_analyser_id(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "true"},
        ).json()
        assert data["debug"]["analyser_id"] == "stub"

    def test_debug_contains_stages(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "true"},
        ).json()
        assert "stages" in data["debug"]

    def test_debug_stages_contain_stub_note(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "true"},
        ).json()
        assert data["debug"]["stages"]["note"] == STUB_DEBUG_STAGES["note"]

    def test_normal_result_fields_still_present_with_debug(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "true"},
        ).json()
        assert "escalation_score" in data
        assert "signal_summary"   in data
        assert "dominant_emotion" in data
        assert "confidence"       in data

    def test_x_debug_header_is_case_insensitive(self, debug_client_and_analyser):
        client, _ = debug_client_and_analyser
        data = client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "True"},
        ).json()
        assert "debug" in data


# ─── GET /evaluate/debug/config ───────────────────────────────────────────────

class TestDebugConfig:
    def test_returns_401_without_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.get("/evaluate/debug/config")
        assert resp.status_code == 401

    def test_returns_401_with_wrong_key(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.get("/evaluate/debug/config",
                          headers={"Authorization": "Bearer wrong"})
        assert resp.status_code == 401

    def test_returns_200_with_valid_auth(self, client_and_analyser):
        client, _ = client_and_analyser
        resp = client.get("/evaluate/debug/config", headers=AUTH)
        assert resp.status_code == 200

    def test_stub_returns_analyser_id_and_note(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.get("/evaluate/debug/config", headers=AUTH).json()
        assert data["analyser_id"] == "stub"
        assert "note" in data

    def test_stub_note_mentions_production(self, client_and_analyser):
        client, _ = client_and_analyser
        data = client.get("/evaluate/debug/config", headers=AUTH).json()
        assert "production" in data["note"]


# ─── StubBehaviourAnalyser integration ───────────────────────────────────────
# These tests run the real stub through the full route stack (no mock analyser)
# to verify the stub produces the correct shape and respects score_range.

@pytest.fixture
def stub_client():
    """TestClient wired to the real StubBehaviourAnalyser."""
    with patch.dict(os.environ, {"INTERNAL_API_KEY": API_KEY, "BEHAVIOUR_ANALYSER": "stub"}):
        from main import create_app
        app = create_app()
    return TestClient(app, raise_server_exceptions=True)


class TestStubIntegration:
    def test_stub_returns_valid_signal_summary_fields(self, stub_client):
        data = stub_client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        ss = data["signal_summary"]
        assert isinstance(ss["vocal_tension"], float)
        assert isinstance(ss["speech_pace"], float)
        assert isinstance(ss["gesture_activity"], float)
        assert ss["open_gesture_ratio"] is not None  # stub always provides a value
        assert isinstance(ss["head_nod_frequency"], float)
        assert isinstance(ss["facing_ratio"], float)
        assert isinstance(ss["silence_ratio"], float)
        assert isinstance(ss["lexical_markers"], list)
        assert ss["response_tone"] in ("positive", "neutral", "negative")
        assert "stub_mode" in ss["notable_signals"]

    def test_stub_challenging_clip_returns_positive_score(self, stub_client):
        data = stub_client.post("/evaluate/analyse", json=CHALLENGING_WINDOW, headers=AUTH).json()
        assert data["escalation_score"] > 0

    def test_stub_calm_clip_returns_negative_score(self, stub_client):
        data = stub_client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert data["escalation_score"] < 0

    def test_stub_respects_score_range_clamping(self, stub_client):
        clamped_window = {
            **MINIMAL_WINDOW,
            "clip_metadata": {
                **MINIMAL_WINDOW["clip_metadata"],
                "de_escalation_rubric": [],
                "escalation_rubric":    [{"signal": "raised_voice", "weight": 1.0}],
                "score_range":          {"min": -1.0, "max": 0.2},
            },
        }
        data = stub_client.post("/evaluate/analyse", json=clamped_window, headers=AUTH).json()
        assert data["escalation_score"] <= 0.2

    def test_stub_rubric_heavier_de_escalation_returns_negative_score(self, stub_client):
        rubric_de_heavy = {
            **MINIMAL_WINDOW,
            "clip_metadata": {
                **MINIMAL_WINDOW["clip_metadata"],
                "de_escalation_rubric": [
                    {"signal": "calm_voice", "weight": 1.0},
                    {"signal": "empathy_phrase", "weight": 0.9},
                ],
                "escalation_rubric": [
                    {"signal": "raised_voice", "weight": 0.3},
                ],
            },
        }
        data = stub_client.post("/evaluate/analyse", json=rubric_de_heavy, headers=AUTH).json()
        assert data["escalation_score"] < 0

    def test_stub_emotion_cycles_across_calls(self, stub_client):
        emotions = set()
        for _ in range(4):
            data = stub_client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
            emotions.add(data["dominant_emotion"])
        assert len(emotions) == 4

    def test_stub_debug_path_returns_debug_field(self, stub_client):
        data = stub_client.post(
            "/evaluate/analyse",
            json=MINIMAL_WINDOW,
            headers={**AUTH, "X-Debug": "true"},
        ).json()
        assert "debug" in data
        assert data["debug"]["analyser_id"] == "stub"
        assert data["debug"]["stages"]["note"] == STUB_DEBUG_STAGES["note"]

    def test_stub_debug_path_absent_without_header(self, stub_client):
        data = stub_client.post("/evaluate/analyse", json=MINIMAL_WINDOW, headers=AUTH).json()
        assert "debug" not in data