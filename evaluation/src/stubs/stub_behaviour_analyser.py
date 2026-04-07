"""
Stub implementation of BehaviourAnalyserInterface.

Returns deterministic but plausible results based on the clip's rubric context
rather than actual signal extraction or model inference. Allows the full session
flow and branching logic to be tested without a trained classifier.

Score derivation:
  - If de_escalation_rubric and escalation_rubric are both empty, falls back to
    the notable_features heuristic (challenging features → 0.4, else -0.2).
  - Otherwise, compares the sum of weights in each rubric. If the escalation
    side is heavier or equal, returns 0.4; otherwise -0.2.
  - The raw score is clamped to the clip's declared score_range before returning,
    so stub scores respect the scenario author's declared range.

Do not use in production. See docs/stub_guide.md for full behaviour spec.
"""

from __future__ import annotations

from interfaces import (
    AnalysisWindow,
    BehaviourAnalyserInterface,
    BehaviourResult,
    DebugStages,
    SignalSummary,
)

_CHALLENGING_FEATURES = {"raised_voice", "aggressive_posture", "pointing_gesture"}
_EMOTIONS             = ["calm", "anxious", "frustrated", "neutral"]

_STUB_DEBUG_STAGES: DebugStages = {
    "note": "stub analyser — no intermediate stage data available",
}


class StubBehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Stub implementation for development and integration testing.
    Returns deterministic results based on clip rubric context.
    Does not run signal extraction or model inference.
    Do not use in production.
    """

    analyser_id = "stub"

    def __init__(self) -> None:
        self._counter: int = 0

    async def analyse(
        self,
        window: AnalysisWindow,
        *,
        collect_debug: bool = False,
    ) -> tuple[BehaviourResult, DebugStages | None]:
        meta = window.clip_metadata

        # Derive raw score from rubric weights; fall back to notable_features heuristic.
        de_weight  = sum(e.weight for e in meta.de_escalation_rubric)
        esc_weight = sum(e.weight for e in meta.escalation_rubric)

        if de_weight == 0.0 and esc_weight == 0.0:
            features  = set(meta.notable_features)
            raw_score = 0.4 if features & _CHALLENGING_FEATURES else -0.2
        else:
            raw_score = 0.4 if esc_weight >= de_weight else -0.2

        # Clamp to declared score_range.
        score = max(meta.score_range.min, min(meta.score_range.max, raw_score))

        emotion = _EMOTIONS[self._counter % len(_EMOTIONS)]
        self._counter += 1

        result = BehaviourResult(
            window_id        = window.window_id,
            session_id       = window.session_id,
            escalation_score = score,
            dominant_emotion = emotion,
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

        stages = _STUB_DEBUG_STAGES if collect_debug else None
        return result, stages