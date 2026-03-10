# =============================================================================
# AR Training — Evaluation Container Interfaces
# Abstract base classes and dataclasses for all Evaluation DTOs.
#
# TypeScript equivalent: shared/types.ts
# Wire format reference: docs/api_contract.md
# =============================================================================

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

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
    min_score: float  # inclusive lower bound
    max_score: float  # exclusive upper bound
    next_clip: str | None  # null = terminal clip

@dataclass
class ClipMetadata:
    """
    Metadata for the clip the student is responding to.
    Forwarded from the App container as part of each AnalysisWindow so the
    classifier has full context about what it is analysing.
    """
    clip_id:          str
    scenario_id:      str
    transcript:       str                   # verbatim dialogue in the clip
    notable_features: list[str]             # e.g. ["raised_voice", "aggressive_posture"]
    branch_conditions: list[BranchCondition]


@dataclass
class VideoFrame:
    """
    One frame of landmark data extracted by MediaPipe.js in the browser.
    Mirrors the TypeScript VideoFrame DTO in shared/types.ts.

    face_landmarks: 478 points
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

    Contains everything the classifier needs: landmark frames, pre-computed
    MFCCs, the full Whisper transcript, and clip context. Each request is
    entirely self-contained — no per-session state is held in this container.

    Wire format: docs/api_contract.md → "POST /evaluate/analyse"
    """
    window_id: str  # "{session_id}:{clip_sequence}"
    session_id: str
    frames: list[VideoFrame]
    mfccs: list[list[float]]  # [n_frames][13], pre-computed by Meyda.js
    transcript: str  # full Whisper transcript for the clip
    clip_metadata: ClipMetadata

# ─── Response ─────────────────────────────────────────────────────────────────

@dataclass
class SignalSummary:
    """
    A summary of the multimodal signals detected in an AnalysisWindow.
    Included in every BehaviourResult and forwarded to the Feedback container.
    """
    voice_tension:   float      # 0.0 (relaxed) to 1.0 (tense)
    speech_pace:     float      # syllables per second
    hand_velocity:   float      # average landmark movement per frame
    gaze_stability:  float      # 0.0 (erratic) to 1.0 (steady)
    open_palm_ratio: float      # ratio of frames where open palm is detected
    notable_signals: list[str]  # e.g. ["raised_voice", "stub_mode"]


@dataclass
class BehaviourResult:
    """
    The result of analysing a single AnalysisWindow.
    Returned by POST /evaluate/analyse to the App container.

    escalation_score drives clip branching:
      -1.0 = strongly de-escalating
       1.0 = strongly escalating

    Wire format: docs/api_contract.md → "POST /evaluate/analyse response"
    """
    window_id:        str
    session_id:       str
    escalation_score: float         # -1.0 to 1.0
    dominant_emotion: str           # e.g. "calm", "angry", "fearful"
    confidence:       float         # 0.0 to 1.0
    signal_summary:   SignalSummary


# ─── Health ───────────────────────────────────────────────────────────────────

@dataclass
class HealthStatus:
    """Response body for GET /evaluate/health."""
    status: str         # "ok"
    device: str = "cpu" # "cpu" | "cuda"


# ─── Interface ────────────────────────────────────────────────────────────────

class BehaviourAnalyserInterface(ABC):
    """
    Abstracts the multimodal behaviour classifier.

    Receives a complete AnalysisWindow covering one clip and returns a single
    BehaviourResult. Each call is stateless — the window contains everything
    needed to produce a result.

    Implementations:
      - StubBehaviourAnalyser          (stubs/stub_behaviour_analyser.py)
      - ProductionBehaviourAnalyser    (models/production_behaviour_analyser.py)
    """

    @abstractmethod
    async def analyse(self, window: AnalysisWindow) -> BehaviourResult:
        """
        Analyse a complete clip window and return a behaviour result.

        Args:
            window: All frames, MFCCs, transcript, and clip metadata for the clip.

        Returns:
            A BehaviourResult with an escalation_score, dominant_emotion,
            confidence, and a SignalSummary of detected multimodal signals.
        """
        ...