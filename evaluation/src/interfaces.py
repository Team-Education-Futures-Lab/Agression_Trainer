# =============================================================================
# AR Training — Evaluation Container Interfaces
# Abstract base classes and dataclasses for all Evaluation DTOs.
#
# TypeScript equivalent: shared/types.ts
# Wire format reference: docs/admin_and_tooling_api.md
# =============================================================================

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

# ─── Sub-types ────────────────────────────────────────────────────────────────

@dataclass
class Landmark:
    """
    A single landmark point in normalized image coordinates (0..1).
    Mirrors the TypeScript Landmark interface in shared/types.ts.
    """
    x: float
    y: float
    z: float
    visibility: float


@dataclass
class BranchCondition:
    """
    Maps an escalation_score range to the next clip to play.
    Conditions are evaluated in order; the first match wins.
    """
    min_score: float        # inclusive lower bound
    max_score: float        # exclusive upper bound
    next_clip: str | None   # None = terminal clip


@dataclass
class RubricEntry:
    """
    A single entry in a clip's de-escalation or escalation rubric.
    Pairs a signal name from the controlled vocabulary with a weight.
    See docs/scenario_schema.md for the signal vocabulary.
    """
    signal: str     # e.g. "calm_voice", "raised_voice"
    weight: float   # relative importance on this clip, 0.0 to 1.0


@dataclass
class ScoreRange:
    """
    Clamps the escalation_score output for a specific clip.
    Applied by the scorer after the weighted sum is computed.
    Defaults to { min: -1.0, max: 1.0 } when absent from the metadata.
    """
    min: float = -1.0
    max: float =  1.0


@dataclass
class ClipMetadata:
    """
    Metadata for the clip the student is responding to.
    Forwarded from the App container as part of each AnalysisWindow so the
    scorer has full context about what it is analysing.

    Evaluation-relevant fields: clip_duration_seconds, scoring_mode,
    de_escalation_rubric, escalation_rubric, critical_failures, score_range,
    notable_features.

    Feedback-relevant fields: clip_learning_objectives, ideal_response,
    response_warnings. These are carried through AnalysisWindow but are
    not used by the scorer — they exist so the full ClipMetadata can be
    forwarded to the Feedback container without a separate fetch.
    """
    clip_id:              str
    scenario_id:          str
    transcript:           str              # verbatim actor dialogue in the clip
    clip_duration_seconds: float           # declared clip length for rate-based signal normalisation
    notable_features:     list[str]        # actor behaviour signals, e.g. ["raised_voice"]
    scoring_mode:         str              # "rubric" | "threshold"
    de_escalation_rubric: list[RubricEntry]  # weighted positive signals for this clip
    escalation_rubric:    list[RubricEntry]  # weighted negative signals for this clip
    critical_failures:    list[str]        # signal names that apply a hard score penalty
    score_range:          ScoreRange       # clamps the final escalation_score
    branch_conditions:    list[BranchCondition]
    # Feedback-only fields — carried through but not used by the scorer
    clip_learning_objectives: list[str]  = field(default_factory=list)
    ideal_response:           str | None = None
    response_warnings:        list[str]  = field(default_factory=list)


@dataclass
class WordTiming:
    """
    A single recognised word with its session-level (clip-relative) start and
    end time. Produced by the Transcription container and forwarded through the
    App container in AnalysisWindow.

    Times are seconds from clip start (reset on each clip reset), matching the
    reference frame of clip_metadata.clip_duration_seconds.
    Used to compute silence_ratio and speech_pace from actual speech boundaries.
    """
    word:  str
    start: float    # seconds from clip start
    end:   float    # seconds from clip start


@dataclass
class VideoFrame:
    """
    One frame of landmark data extracted by MediaPipe.js in the browser.
    Mirrors the TypeScript VideoFrame DTO in shared/types.ts.

    face_landmarks: 478 MediaPipe face mesh points (face only, no body pose)
    left_hand / right_hand: 21 points each, empty list if not detected
    """
    session_id:     str
    frame_id:       int
    timestamp:      float
    face_landmarks: list[Landmark]
    left_hand:      list[Landmark]
    right_hand:     list[Landmark]


# ─── Request ──────────────────────────────────────────────────────────────────

@dataclass
class AnalysisWindow:
    """
    A complete window of captured data for one clip, assembled by the App
    container and sent to POST /evaluate/analyse.

    Contains everything the scorer needs: landmark frames, pre-computed
    MFCCs, the full Whisper transcript, session-level word timings, and clip
    context. Each request is entirely self-contained — no per-session state
    is held in this container.

    Wire format: docs/admin_and_tooling_api.md → "POST /evaluate/analyse"
    """
    window_id:     str              # "{session_id}:{clip_sequence}"
    session_id:    str
    frames:        list[VideoFrame]
    mfccs:         list[list[float]]  # [n_frames][13], pre-computed by Meyda.js
    transcript:    str              # full Whisper transcript for the student's response
    words:         list[WordTiming] # session-level word timings; empty when stub pool used
    clip_metadata: ClipMetadata


# ─── Response ─────────────────────────────────────────────────────────────────

@dataclass
class SignalSummary:
    """
    The computed multimodal signals produced by the evaluation pipeline
    for a single clip. Included in every BehaviourResult and forwarded
    to the Feedback container so the LLM has interpretable evidence.

    See docs/architecture.md for how each signal is computed.
    """
    vocal_tension:      float           # 0.0 (relaxed) to 1.0 (tense)
    speech_pace:        float           # syllables per second of actual speech
    gesture_activity:   float           # variance of wrist/fingertip displacement
    open_gesture_ratio: float | None    # fraction of hand-detected frames with open hand;
                                        # None if hands detected in fewer than 50% of frames
    head_nod_frequency: float           # Hz, from face landmark Y-oscillation
    facing_ratio:       float           # fraction of frames where the face is estimated
                                        # forward-facing, based on horizontal symmetry of
                                        # left/right face mesh landmarks (indices 234/93 and
                                        # 454/323). Computed from MediaPipe face mesh (478
                                        # points) — shoulder landmarks are not available from
                                        # the client's capture pipeline.
    silence_ratio:      float           # fraction of clip_duration_seconds with no student speech
    lexical_markers:    list[str]       # rubric category labels detected in the transcript:
                                        # "empathy_phrase", "open_question", "validation"
    response_tone:      str             # "positive" | "neutral" | "negative"
    notable_signals:    list[str]       # e.g. ["stub_mode", "critical_failure:raised_voice",
                                        #       "no_hands_detected"]


@dataclass
class BehaviourResult:
    """
    The result of analysing a single AnalysisWindow.
    Returned by POST /evaluate/analyse to the App container.

    escalation_score drives clip branching:
      -1.0 = strongly de-escalating
       1.0 = strongly escalating

    The score is produced by the deterministic weighted scorer from
    SignalSummary and the clip rubric, then clamped to clip_metadata.score_range.

    Wire format: docs/admin_and_tooling_api.md → "POST /evaluate/analyse response"
    """
    window_id:        str
    session_id:       str
    escalation_score: float           # -1.0 to 1.0, clamped to score_range
    dominant_emotion: str             # "calm" | "anxious" | "frustrated" | "neutral" | "distressed"
    confidence:       float           # 0.0 to 1.0
    signal_summary:   SignalSummary


# ─── Debug ────────────────────────────────────────────────────────────────────

# Type alias for the stages dict returned alongside BehaviourResult when
# collect_debug=True. The shape is implementation-specific and is keyed on
# analyser_id by the route handler before forwarding to the client.
# See docs/admin_and_tooling_api.md → "Evaluation container — debug output".
DebugStages = dict  # dict | None


# ─── Health ───────────────────────────────────────────────────────────────────

@dataclass
class HealthStatus:
    """Response body for GET /evaluate/health."""
    status: str         # "ok"
    device: str = "cpu" # "cpu" | "cuda"


# ─── Interface ────────────────────────────────────────────────────────────────

class BehaviourAnalyserInterface(ABC):
    """
    Abstracts the behaviour analyser pipeline.

    Receives a complete AnalysisWindow covering one clip and returns a single
    BehaviourResult, plus an optional debug stages dict when collect_debug=True.

    Each call is stateless — the window contains everything needed to produce
    a result. The stages dict is only assembled when collect_debug=True so that
    non-debug sessions bear no overhead from intermediate data collection.

    The production implementation runs the four-stage pipeline
    (audio emotion extraction, landmark feature extraction, transcript feature
    extraction, deterministic weighted scorer) described in docs/architecture.md.

    Implementations:
      - StubBehaviourAnalyser  (stubs/stub_behaviour_analyser.py)
      - BehaviourAnalyser      (behaviour_analyser.py)

    Class attribute:
      analyser_id: str — stable identifier forwarded to the client in the
                         debug_eval WebSocket message. Must be set on every
                         concrete subclass.
    """

    analyser_id: str  # must be set on every concrete subclass

    @abstractmethod
    async def analyse(
        self,
        window: AnalysisWindow,
        *,
        collect_debug: bool = False,
    ) -> tuple[BehaviourResult, DebugStages | None]:
        """
        Analyse a complete clip window and return a (result, stages) tuple.

        Args:
            window:        All frames, MFCCs, transcript, word timings, and
                           clip metadata for the clip.
            collect_debug: When True, the second element of the returned tuple
                           is a dict of implementation-specific intermediate
                           data (the `stages` payload). When False, the second
                           element is None and no intermediate data is assembled.
                           The route handler passes collect_debug=True only for
                           admin sessions (X-Debug: true header).

        Returns:
            (BehaviourResult, stages_dict | None)
              BehaviourResult — escalation_score, dominant_emotion, confidence,
                                and a SignalSummary of detected multimodal signals.
              stages_dict     — implementation-specific debug intermediates, or
                                None when collect_debug=False.
        """
        ...