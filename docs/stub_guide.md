# Stub Implementations

Several components require trained models or external services that may not be available during development. Stub implementations allow the full pipeline to be developed and tested end-to-end before real models or services are in place.

Stubs are not fallback behaviour. They exist only for development and integration testing. They should never be deployed in a real session.

---

## Overview

| Container     | Interface                  | Env variable           | Default  |
|---------------|----------------------------|------------------------|----------|
| Transcription | `TranscriptionPoolInterface` | `TRANSCRIPTION_POOL` | `stub`   |
| Evaluation    | `BehaviourAnalyserInterface` | `BEHAVIOUR_ANALYSER` | `stub`   |
| Feedback      | `FeedbackGeneratorInterface` | `FEEDBACK_GENERATOR` | `stub`   |

---

## Switching Between Stub and Real Implementations

Each container selects its implementation based on an environment variable. The container's factory function instantiates the correct class:

```python
# Transcription container (transcription/src/main.py)
match cfg.pool_impl:
    case "stub":
        from stubs.stub_transcription_pool import StubTranscriptionPool
        return StubTranscriptionPool()
    case "production":
        from whisper_pool import WhisperPool
        return WhisperPool(cfg)

# Evaluation container (evaluation/src/main.py)
match os.environ.get("BEHAVIOUR_ANALYSER", "stub"):
    case "stub":
        from stubs.behaviour_analyser import StubBehaviourAnalyser
        return StubBehaviourAnalyser()
    case "production":
        from models.behaviour_analyser import ProductionBehaviourAnalyser
        return ProductionBehaviourAnalyser()
```

This pattern means no other code needs to change when swapping implementations.

---

## `StubTranscriptionPool`

Returns a fixed Dutch placeholder string without running Whisper. Allows the full audio pipeline to be exercised — WebSocket connections, PCM buffering, rolling windows, finalisation — without requiring a downloaded Whisper model.

### Behaviour

- `transcribe()` always returns the text `"[stub] dit is een teststranscriptie."` with `confidence: 1.0`, regardless of the PCM content.
- Reports `worker_count: 1`, `available_workers: 1`, `device: "cpu"`.

### When to use

Set `TRANSCRIPTION_POOL=stub` (the default) during development and in CI. The stub is fast and requires no model download, making it suitable for end-to-end pipeline tests.

> **Note:** Unlike the Evaluation and Feedback stubs, the Transcription container has a real production implementation (`WhisperPool`) already available. Switch to `TRANSCRIPTION_POOL=production` whenever you need actual transcription quality.

---

## `StubBehaviourAnalyser`

Returns a deterministic but plausible `BehaviourResult` based on the clip context rather than actual analysis. Allows the branching logic and full session flow to be tested without a trained classifier.

### Behaviour

- If the clip's `notable_features` include `raised_voice`, `aggressive_posture`, or `pointing_gesture`, returns a mildly positive `escalation_score` (0.4) to simulate a student struggling to de-escalate.
- Otherwise returns a mildly negative score (-0.2) to simulate reasonable de-escalation.
- `confidence` is always `1.0`.
- `dominant_emotion` cycles through `["calm", "anxious", "frustrated", "neutral"]` for varied but predictable output.
- `signal_summary` values are hardcoded to mid-range floats.

### Implementation

```python
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
        for word in feedback.advice.split():
            yield word + " "
```

---

## Testing the Full Pipeline with Stubs

With all stubs active, a complete session flows as follows:

1. `POST /session/create` → `SessionContext` with `state: active`
2. Open WebSocket → send `VideoFrame` and `AudioChunk` messages
3. Receive `SessionUpdate` messages carrying the live accumulated transcript as the Transcription container processes audio
4. Send `ClipEnded` when the clip finishes playing
5. Receive `ClipReady` with the resolved `next_clip_id` and `clip_score` from `StubBehaviourAnalyser`
6. If `next_clip_id` is non-null: load the next clip and repeat from step 2
7. If `next_clip_id` is null: the scenario is complete — wait for the debrief
8. Receive `FeedbackToken` stream then `SessionComplete` from `StubFeedbackGenerator`

If this flow completes without errors, the full inter-container pipeline is working correctly and real implementations can be dropped in independently.

> **Note:** `POST /session/{id}/end` exists as an explicit termination route but is not part of the normal clip flow. Feedback is triggered automatically when a terminal clip is reached via `ClipEnded`. The `/end` route handles abnormal termination only.

---

## What Stubs Do Not Test

- Accuracy or quality of escalation scoring
- Whisper transcription quality — switch to `TRANSCRIPTION_POOL=production` to test real transcription
- Ollama availability or prompt formatting
- Edge cases in `BranchCondition` evaluation with real score distributions

Human judgment is required to validate model output once real implementations are in place.