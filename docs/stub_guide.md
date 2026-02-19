# Stub Implementations

The AI components — `BehaviourAnalyserInterface` and `FeedbackGeneratorInterface` — require trained models that do not yet exist. Stub implementations allow the full pipeline to be developed and tested end-to-end before real models are available.

Stubs are not fallback behaviour. They exist only for development and integration testing. They should never be deployed in a real session.

---

## Switching Between Stub and Real Implementations

Each container selects its implementation based on an environment variable. Set these in `.env`:

```bash
# Evaluation container
BEHAVIOUR_ANALYSER=stub        # 'stub' | 'production'

# Feedback container  
FEEDBACK_GENERATOR=stub        # 'stub' | 'production'
```

The container's entrypoint instantiates the correct class based on this variable:

```python
import os
from interfaces import BehaviourAnalyserInterface

def get_behaviour_analyser() -> BehaviourAnalyserInterface:
    match os.environ.get("BEHAVIOUR_ANALYSER", "stub"):
        case "stub":
            from stubs.behaviour_analyser import StubBehaviourAnalyser
            return StubBehaviourAnalyser()
        case "production":
            from models.behaviour_analyser import ProductionBehaviourAnalyser
            return ProductionBehaviourAnalyser()
        case other:
            raise ValueError(f"Unknown BEHAVIOUR_ANALYSER: {other}")
```

This pattern means no other code needs to change when swapping implementations.

---

## `StubBehaviourAnalyser`

Returns a deterministic but plausible `BehaviourResult` based on the clip context rather than actual analysis. This allows the branching logic to be tested without a real model.

### Behaviour

- If the clip's `notable_features` include `raised_voice` or `aggressive_posture`, return a mildly positive `escalation_score` (0.3–0.6) to simulate a student struggling to de-escalate.
- Otherwise return a mildly negative score (-0.2–0.1) to simulate reasonable de-escalation.
- `confidence` is always `1.0` (stub is always "certain").
- `dominant_emotion` cycles through a fixed list to give varied but predictable output.
- `signal_summary` values are hardcoded to mid-range floats.

### Implementation

```python
from dataclasses import dataclass
from interfaces import BehaviourAnalyserInterface, AnalysisWindow, BehaviourResult, SignalSummary

class StubBehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Stub implementation for development and integration testing.
    Returns plausible but hardcoded results based on clip context.
    Do not use in production.
    """
    _emotions = ["calm", "anxious", "frustrated", "neutral"]
    _counter = 0

    async def analyse(self, window: AnalysisWindow) -> BehaviourResult:
        features = window.clip_metadata.notable_features
        is_challenging = any(f in features for f in ["raised_voice", "aggressive_posture", "pointing_gesture"])
        score = 0.4 if is_challenging else -0.2
        emotion = self._emotions[self._counter % len(self._emotions)]
        self._counter += 1

        return BehaviourResult(
            window_id=window.window_id,
            session_id=window.session_id,
            escalation_score=score,
            dominant_emotion=emotion,
            confidence=1.0,
            signal_summary=SignalSummary(
                voice_tension=0.5,
                speech_pace=3.2,
                hand_velocity=0.3,
                gaze_stability=0.7,
                open_palm_ratio=0.6,
                notable_signals=["stub_mode"],
            ),
        )
```

---

## `StubFeedbackGenerator`

Returns a canned `Feedback` object without calling Ollama. Useful for testing the full session flow including the debrief screen without needing Ollama running.

### Behaviour

- Always returns `severity: "medium"`.
- `advice` is a fixed Dutch placeholder string.
- `highlights` references the first and last turn in the history to verify that turn references are wired correctly.

### Implementation

```python
from interfaces import FeedbackGeneratorInterface, FeedbackRequest, Feedback
from typing import AsyncIterator

class StubFeedbackGenerator(FeedbackGeneratorInterface):
    """
    Stub implementation for development and integration testing.
    Returns hardcoded feedback without calling Ollama.
    Do not use in production.
    """

    async def generate(self, req: FeedbackRequest) -> Feedback:
        highlights = []
        if req.history:
            highlights.append(f"Turn {req.history[0].turn_id}: [stub] eerste reactie geanalyseerd.")
        if len(req.history) > 1:
            highlights.append(f"Turn {req.history[-1].turn_id}: [stub] laatste reactie geanalyseerd.")

        return Feedback(
            session_id=req.session_id,
            advice=(
                "[STUB] Dit is een testfeedback. In een echte sessie zou hier een "
                "gepersonaliseerde analyse van jouw de-escalatiegedrag staan, gegenereerd "
                "op basis van jouw reacties op de videoscenario's."
            ),
            severity="medium",
            highlights=highlights,
        )

    async def generate_stream(self, req: FeedbackRequest) -> AsyncIterator[str]:
        feedback = await self.generate(req)
        # Simulate token-by-token streaming by yielding words one at a time
        for word in feedback.advice.split():
            yield word + " "
```

---

## Testing the Full Pipeline with Stubs

With both stubs active, a complete session should flow as follows:

1. `POST /session/create` → `SessionContext` with `state: active`
2. Open WebSocket → send `VideoFrame` and `AudioChunk` messages
3. Receive `SessionUpdate` with `escalation_score` from `StubBehaviourAnalyser`
4. Client branches video based on score
5. Repeat for each clip
6. `POST /session/{id}/end`
7. Receive `feedback_token` stream then `session_complete` from `StubFeedbackGenerator`

If this flow completes without errors, the full inter-container pipeline is working correctly and real model implementations can be dropped in independently.

---

## What Stubs Do Not Test

- Accuracy or quality of escalation scoring
- Whisper transcription (the `TranscriptionInterface` should use a real Whisper instance even during stub testing — it is infrastructure, not a model)
- Ollama availability or prompt formatting
- Edge cases in `BranchCondition` evaluation with real score distributions

Human judgment is required to validate model output once real implementations are in place.
