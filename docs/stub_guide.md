# Stub Implementations

Several components require trained models or external services that may not be available during development. Stub implementations allow the full pipeline to be developed and tested end-to-end before real models or services are in place.

Stubs are not fallback behaviour. They exist only for development and integration testing. They should never be deployed in a real session.

---

## Overview

| Container     | Interface                    | Env variable         | Default |
|---------------|------------------------------|----------------------|---------|
| Transcription | `TranscriptionPoolInterface` | `TRANSCRIPTION_POOL` | `stub`  |
| Evaluation    | `BehaviourAnalyserInterface` | `BEHAVIOUR_ANALYSER` | `stub`  |
| Feedback      | `FeedbackGeneratorInterface` | `FEEDBACK_GENERATOR` | `stub`  |

---

## Switching Between Stub and Real Implementations

Each container selects its implementation based on an environment variable. The container's factory function instantiates the correct class.

**Python containers (Transcription, Evaluation):**

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
match cfg.analyser_impl:
    case "stub":
        from stubs.stub_behaviour_analyser import StubBehaviourAnalyser
        return StubBehaviourAnalyser()
    case "production":
        from behaviour_analyser import BehaviourAnalyser
        return BehaviourAnalyser(cfg)
```

**TypeScript container (Feedback):**

```typescript
// Feedback container (feedback/src/main.ts)
const generator: FeedbackGeneratorInterface =
    config.generatorImpl === "production"
        ? new OllamaFeedbackGenerator(config)
        : new StubFeedbackGenerator();
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

Returns a deterministic but plausible `BehaviourResult` based on the clip's rubric context, without running any signal extraction or model inference. Allows the branching logic and full session flow to be tested immediately.

### Behaviour

- Inspects the clip's `escalation_rubric` and `de_escalation_rubric` to determine which side is heavier (by sum of weights). If the escalation side is heavier, returns a mildly positive `escalation_score` (0.4); otherwise returns a mildly negative score (−0.2). Falls back to `notable_features` heuristic (challenging features → 0.4, otherwise −0.2) if both rubrics are empty.
- `confidence` is always `1.0`.
- `dominant_emotion` cycles through `["calm", "anxious", "frustrated", "neutral"]` for varied but predictable output.
- `signal_summary` values are hardcoded mid-range floats. `open_gesture_ratio` is `0.6`. `lexical_markers` is an empty list. `response_tone` is `"neutral"`. `notable_signals` is `["stub_mode"]`.
- `escalation_score` is clamped to the clip's `score_range` before returning, so stub scores respect the scenario author's declared range.

### Implementation

```python
# evaluation/src/stubs/stub_behaviour_analyser.py
from interfaces import BehaviourAnalyserInterface, AnalysisWindow, BehaviourResult, SignalSummary

_CHALLENGING_FEATURES = {"raised_voice", "aggressive_posture", "pointing_gesture"}
_EMOTIONS             = ["calm", "anxious", "frustrated", "neutral"]

class StubBehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Stub implementation for development and integration testing.
    Returns deterministic results based on clip rubric context.
    Does not run signal extraction or model inference.
    Do not use in production.
    """

    def __init__(self) -> None:
        self._counter: int = 0

    async def analyse(self, window: AnalysisWindow) -> BehaviourResult:
        meta = window.clip_metadata

        # Determine raw score from rubric weights, fall back to notable_features
        de_weight  = sum(e.weight for e in meta.de_escalation_rubric)
        esc_weight = sum(e.weight for e in meta.escalation_rubric)
        if de_weight == 0 and esc_weight == 0:
            features    = set(meta.notable_features)
            raw_score   = 0.4 if features & _CHALLENGING_FEATURES else -0.2
        else:
            raw_score   = 0.4 if esc_weight >= de_weight else -0.2

        # Clamp to declared score_range
        score = max(meta.score_range.min, min(meta.score_range.max, raw_score))

        emotion = _EMOTIONS[self._counter % len(_EMOTIONS)]
        self._counter += 1

        return BehaviourResult(
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
```

---

## `StubFeedbackGenerator`

Returns a canned `Feedback` object without calling Ollama. Useful for testing the full session flow including the debrief screen without needing Ollama running.

### Behaviour

- Always returns `severity: "medium"`.
- `advice` is a fixed Dutch placeholder string.
- `highlights` references the first and last turn in the history to verify that turn references are wired correctly.
- `generateStream()` splits the canned advice word by word and yields tokens with a small artificial delay to simulate realistic streaming behaviour.

### Implementation

```typescript
// feedback/src/stub-feedback-generator.ts
import type { FeedbackRequest, Feedback } from "@ar-training/shared";
import type { FeedbackGeneratorInterface } from "./interfaces.js";

const STUB_ADVICE =
    "[STUB] Dit is een testfeedback. In een echte sessie zou hier een " +
    "gepersonaliseerde analyse van jouw de-escalatiegedrag staan, gegenereerd " +
    "op basis van jouw reacties op de videoscenario's.";

export class StubFeedbackGenerator implements FeedbackGeneratorInterface {
    /**
     * Stub implementation for development and integration testing.
     * Returns hardcoded feedback without calling Ollama.
     * Do not use in production.
     */

    async generate(req: FeedbackRequest): Promise<Feedback> {
        const highlights: string[] = [];
        if (req.history.length > 0) {
            highlights.push(`Turn ${req.history[0].turn_id}: [stub] eerste reactie geanalyseerd.`);
        }
        if (req.history.length > 1) {
            highlights.push(
                `Turn ${req.history[req.history.length - 1].turn_id}: [stub] laatste reactie geanalyseerd.`
            );
        }
        return {
            session_id: req.session_id,
            advice:     STUB_ADVICE,
            severity:   "medium",
            highlights,
        };
    }

    async *generateStream(req: FeedbackRequest): AsyncGenerator<string> {
        const feedback = await this.generate(req);
        for (const word of feedback.advice.split(" ")) {
            yield word + " ";
            await new Promise<void>(resolve => setTimeout(resolve, 30));
        }
    }
}
```

---

## Testing the Full Pipeline with Stubs

With all stubs active, a complete session flows as follows:

1. `POST /session/create` → `SessionContext` with `state: active`
2. Open WebSocket → send `VideoFrame` and `AudioChunk` messages
3. Receive `SessionUpdate` messages carrying the live accumulated transcript as the Transcription container processes audio
4. Send `ClipEnded` when the clip finishes playing
5. Receive `clip_candidates` immediately — full clip data for each possible next clip, allowing preloading to begin while evaluation runs
6. Receive `clip_selected` with the resolved `next_clip_id` and `clip_score` from `StubBehaviourAnalyser`
7. If `next_clip_id` is non-null: load the next clip and repeat from step 2
8. If `next_clip_id` is null: the scenario is complete — wait for the debrief
9. Receive `FeedbackToken` stream then `SessionComplete` from `StubFeedbackGenerator`

If this flow completes without errors, the full inter-container pipeline is working correctly and real implementations can be dropped in independently.

> **Note:** `POST /session/{id}/end` exists as an explicit termination route but is not part of the normal clip flow. Feedback is triggered automatically when a terminal clip is reached via `ClipEnded`. The `/end` route handles abnormal termination only and does **not** stream feedback to the client.

---

## What Stubs Do Not Test

- Signal extraction accuracy — Stages A, B, and C of the evaluation pipeline are fully bypassed by the stub
- Whisper transcription quality — switch to `TRANSCRIPTION_POOL=production` to test real transcription
- Rubric scoring logic — the stub returns a fixed score derived from rubric weight sums, not from computed signals
- Ollama availability or prompt formatting
- Edge cases in `BranchCondition` evaluation with real score distributions

Human judgment is required to validate signal extraction and scoring quality once real implementations are in place.