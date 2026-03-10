"""
Stub implementation of BehaviourAnalyserInterface.

Returns deterministic but plausible results based on clip context rather than
actual analysis. Allows the full session flow and branching logic to be tested
without a trained classifier.

Do not use in production. See docs/stub_guide.md for full behaviour spec.
"""

from __future__ import annotations

from interfaces import (
    AnalysisWindow,
    BehaviourAnalyserInterface,
    BehaviourResult,
    SignalSummary,
)

_CHALLENGING_FEATURES = {"raised_voice", "aggressive_posture", "pointing_gesture"}
_EMOTIONS             = ["calm", "anxious", "frustrated", "neutral"]


class StubBehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Stub implementation for development and integration testing.
    Returns plausible but hardcoded results based on clip context.
    Do not use in production.
    """

    def __init__(self) -> None:
        self._counter: int = 0

    async def analyse(self, window: AnalysisWindow) -> BehaviourResult:
        features       = set(window.clip_metadata.notable_features)
        is_challenging = bool(features & _CHALLENGING_FEATURES)
        score          = 0.4 if is_challenging else -0.2
        emotion        = _EMOTIONS[self._counter % len(_EMOTIONS)]
        self._counter += 1

        return BehaviourResult(
            window_id        = window.window_id,
            session_id       = window.session_id,
            escalation_score = score,
            dominant_emotion = emotion,
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
