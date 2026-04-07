"""
Production implementation of BehaviourAnalyserInterface.

Runs the four-stage evaluation pipeline described in docs/architecture.md:

  Stage A — Audio Emotion Extraction
    Input:  mfccs [n_frames][13] from AnalysisWindow
    Models: audeering/wav2vec2-large-robust-12-ft-emotion-msp-dim
            Outputs arousal (0-1) and valence (-1-1); arousal + MFCC energy
            variance feed vocal_tension. Dominant emotion label from the
            classifier head.
    Note:   The model expects raw float32 audio at 16 kHz. MFCCs are
            reconstructed to approximate audio via librosa inverse MFCC.
            The reconstruction is lossy but preserves the prosodic features
            that emotion classifiers depend on.

  Stage B — Landmark Feature Extraction
    Input:  frames [VideoFrame] from AnalysisWindow
    Purely deterministic signal processing — no model needed.
    Extracts: gesture_activity, open_gesture_ratio, head_nod_frequency,
              facing_ratio.

  Stage C — Transcript Feature Extraction
    Input:  transcript (str) + words (WordTiming[]) from AnalysisWindow
    Models: cardiffnlp/twitter-xlm-roberta-base-sentiment
            Three-class (negative/neutral/positive) multilingual sentiment.
    Rule-based: silence_ratio, speech_pace, lexical_markers.

  Scorer — Deterministic Weighted Scorer
    Input:  SignalSummary + clip_metadata rubric
    Maps computed signals to rubric signal names, applies rubric weights,
    computes escalation_score, clamps to score_range.

Stages A, B, C run concurrently via asyncio.gather; the scorer runs after
all three complete.

Models are loaded once at construction time (during app lifespan startup)
so the container fails fast on missing models rather than on first request.
All synchronous model inference runs in a ThreadPoolExecutor to avoid
blocking the asyncio event loop.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import re
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from config import EvaluationConfig
from interfaces import (
    AnalysisWindow,
    BehaviourAnalyserInterface,
    BehaviourResult,
    DebugStages,
    SignalSummary,
    WordTiming,
)

if TYPE_CHECKING:
    import torch

logger = logging.getLogger(__name__)

# ─── Implementation-detail constants (not tuning parameters) ──────────────────
# These are algorithmic parameters that affect measurement reliability and
# signal processing quality. They are not pedagogical thresholds and must
# not be moved to the config file.

# Face mesh landmark indices used for lateral symmetry (facing_ratio).
# MediaPipe face mesh indices for approximate cheekbone/ear region.
# Left side: 234 (left cheek), 93 (left ear region approximation)
# Right side: 454 (right cheek), 323 (right ear region approximation)
# Note: these are face mesh (478-point) indices, not body pose landmarks.
# Shoulder landmarks are not available from the client's capture pipeline.
_FACE_LEFT_INDICES  = [234, 93]
_FACE_RIGHT_INDICES = [454, 323]

# Hand landmark indices for wrists and fingertips.
_WRIST_INDEX      = 0
_FINGERTIP_INDICES = [4, 8, 12, 16, 20]

# Nose tip and forehead landmark indices for head nod Y-oscillation.
_NOSE_TIP_INDEX = 1
_FOREHEAD_INDEX = 10

# Rolling window size (frames) for smoothing head landmark Y coordinates
# before FFT. This is an FFT pre-processing parameter, not a pedagogy setting.
_NOD_SMOOTH_WINDOW = 5

# Hand presence below this fraction of frames → open_gesture_ratio = None.
# This is a measurement reliability threshold: when hands are detected in fewer
# than this fraction of frames, open_gesture_ratio is too noisy to use for
# scoring. It is not a threshold over student behaviour.
_MIN_HAND_DETECTION_RATIO = 0.50

# ─── TOML config dataclasses and loader ───────────────────────────────────────
# These are private to BehaviourAnalyser. EvaluationConfig carries only
# infrastructure config; implementation-specific tuning lives here.

@dataclass(frozen=True)
class _SignalThresholds:
    raised_voice_tension_threshold:  float
    calm_voice_tension_threshold:    float
    fast_speech_pace_threshold:      float   # syl/s
    measured_pace_threshold:         float   # syl/s
    closed_gesture_threshold:        float
    open_gesture_threshold:          float
    nod_frequency_threshold:         float   # Hz
    turning_away_threshold:          float
    open_posture_threshold:          float
    long_silence_threshold:          float
    appropriate_silence_min:         float
    appropriate_silence_max:         float


@dataclass(frozen=True)
class _LexicalMarkers:
    empathy_phrases:       list[str]
    open_question_phrases: list[str]
    validation_phrases:    list[str]


def _clamp01(sec: str, key: str, val: object) -> float:
    if not isinstance(val, (int, float)):
        raise RuntimeError(f"[{sec}].{key} must be a number, got {type(val).__name__!r}")
    f = float(val)
    if not (0.0 <= f <= 1.0):
        raise RuntimeError(f"[{sec}].{key} = {f} is out of range; must be 0.0–1.0")
    return f


def _positive_float(sec: str, key: str, val: object) -> float:
    if not isinstance(val, (int, float)):
        raise RuntimeError(f"[{sec}].{key} must be a number, got {type(val).__name__!r}")
    f = float(val)
    if f <= 0.0:
        raise RuntimeError(f"[{sec}].{key} = {f} must be greater than 0.0")
    return f


def _phrase_list(sec: str, key: str, val: object) -> list[str]:
    if not isinstance(val, list):
        raise RuntimeError(f"[{sec}].{key} must be an array of strings, got {type(val).__name__!r}")
    result: list[str] = []
    for i, item in enumerate(val):
        if not isinstance(item, str) or not item.strip():
            raise RuntimeError(f"[{sec}].{key}[{i}] must be a non-empty string, got {item!r}")
        result.append(item.strip())
    return result


def _load_analyser_config(path: Path) -> tuple[_SignalThresholds, _LexicalMarkers]:
    """Load and validate evaluation_config.toml. Raises RuntimeError on any problem."""
    if not path.exists():
        raise RuntimeError(
            f"BehaviourAnalyser tuning config not found: {path}\n"
            "Ensure evaluation_config.toml is present in the evaluation/ directory, "
            "or set EVALUATION_CONFIG to its location."
        )
    try:
        with open(path, "rb") as fh:
            data = tomllib.load(fh)
    except tomllib.TOMLDecodeError as exc:
        raise RuntimeError(f"Failed to parse TOML config {path}: {exc}") from exc

    sec = "signal_thresholds"
    if sec not in data:
        raise RuntimeError(f"Missing required section [{sec}] in {path}")
    st = data[sec]

    def _get(key: str) -> object:
        if key not in st:
            raise RuntimeError(f"Missing required key [{sec}].{key} in {path}")
        return st[key]

    raised_voice   = _clamp01(sec, "raised_voice_tension_threshold", _get("raised_voice_tension_threshold"))
    calm_voice     = _clamp01(sec, "calm_voice_tension_threshold",   _get("calm_voice_tension_threshold"))
    if calm_voice >= raised_voice:
        raise RuntimeError(
            f"[{sec}].calm_voice_tension_threshold ({calm_voice}) must be "
            f"less than raised_voice_tension_threshold ({raised_voice})"
        )

    fast_pace     = _positive_float(sec, "fast_speech_pace_threshold", _get("fast_speech_pace_threshold"))
    measured_pace = _positive_float(sec, "measured_pace_threshold",    _get("measured_pace_threshold"))
    if measured_pace >= fast_pace:
        raise RuntimeError(
            f"[{sec}].measured_pace_threshold ({measured_pace}) must be "
            f"less than fast_speech_pace_threshold ({fast_pace})"
        )

    closed_gesture = _clamp01(sec, "closed_gesture_threshold", _get("closed_gesture_threshold"))
    open_gesture   = _clamp01(sec, "open_gesture_threshold",   _get("open_gesture_threshold"))
    if closed_gesture >= open_gesture:
        raise RuntimeError(
            f"[{sec}].closed_gesture_threshold ({closed_gesture}) must be "
            f"less than open_gesture_threshold ({open_gesture})"
        )

    nod_freq     = _positive_float(sec, "nod_frequency_threshold", _get("nod_frequency_threshold"))
    turning_away = _clamp01(sec, "turning_away_threshold", _get("turning_away_threshold"))
    open_posture = _clamp01(sec, "open_posture_threshold", _get("open_posture_threshold"))
    if turning_away >= open_posture:
        raise RuntimeError(
            f"[{sec}].turning_away_threshold ({turning_away}) must be "
            f"less than open_posture_threshold ({open_posture})"
        )

    long_silence = _clamp01(sec, "long_silence_threshold",  _get("long_silence_threshold"))
    silence_min  = _clamp01(sec, "appropriate_silence_min", _get("appropriate_silence_min"))
    silence_max  = _clamp01(sec, "appropriate_silence_max", _get("appropriate_silence_max"))
    if silence_min >= silence_max:
        raise RuntimeError(
            f"[{sec}].appropriate_silence_min ({silence_min}) must be "
            f"less than appropriate_silence_max ({silence_max})"
        )
    if silence_max >= long_silence:
        raise RuntimeError(
            f"[{sec}].appropriate_silence_max ({silence_max}) must be "
            f"less than long_silence_threshold ({long_silence})"
        )

    thresholds = _SignalThresholds(
        raised_voice_tension_threshold = raised_voice,
        calm_voice_tension_threshold   = calm_voice,
        fast_speech_pace_threshold     = fast_pace,
        measured_pace_threshold        = measured_pace,
        closed_gesture_threshold       = closed_gesture,
        open_gesture_threshold         = open_gesture,
        nod_frequency_threshold        = nod_freq,
        turning_away_threshold         = turning_away,
        open_posture_threshold         = open_posture,
        long_silence_threshold         = long_silence,
        appropriate_silence_min        = silence_min,
        appropriate_silence_max        = silence_max,
    )

    sec = "lexical_markers"
    if sec not in data:
        raise RuntimeError(f"Missing required section [{sec}] in {path}")
    lm = data[sec]

    def _get_lm(key: str) -> object:
        if key not in lm:
            raise RuntimeError(f"Missing required key [{sec}].{key} in {path}")
        return lm[key]

    markers = _LexicalMarkers(
        empathy_phrases       = _phrase_list(sec, "empathy_phrases",       _get_lm("empathy_phrases")),
        open_question_phrases = _phrase_list(sec, "open_question_phrases", _get_lm("open_question_phrases")),
        validation_phrases    = _phrase_list(sec, "validation_phrases",    _get_lm("validation_phrases")),
    )

    return thresholds, markers


# ─── Stage A intermediate results ─────────────────────────────────────────────

@dataclass
class _AudioEmotionResult:
    arousal:          float  # 0.0–1.0 from dimensional head
    valence:          float  # -1.0–1.0 from dimensional head
    dominant_emotion: str    # "calm" | "anxious" | "frustrated" | "neutral" | "distressed"
    vocal_tension:    float  # derived from arousal + MFCC energy variance, 0.0–1.0
    energy_var_norm:  float  # normalised MFCC energy variance (debug only)


# ─── Stage B intermediate results ─────────────────────────────────────────────

@dataclass
class _LandmarkResult:
    gesture_activity:     float
    open_gesture_ratio:   float | None
    head_nod_frequency:   float
    facing_ratio:         float
    hands_detected_ratio: float
    facing_frame_count:   int    # debug: frames where face was forward-facing
    total_frame_count:    int    # debug: total frames processed
    nod_fft_peak_hz:      float  # debug: same as head_nod_frequency; named for clarity
    notable_signals:      list[str]


# ─── Stage C intermediate results ─────────────────────────────────────────────

@dataclass
class _TranscriptResult:
    speech_pace:        float
    silence_ratio:      float
    lexical_markers:    list[str]  # category labels: "empathy_phrase", "open_question", "validation"
    response_tone:      str        # "positive" | "neutral" | "negative"
    speech_duration_s:  float      # debug: cumulative speech time from word timings
    silence_duration_s: float      # debug: clip_duration - speech_duration
    word_count:         int        # debug
    syllable_count:     int        # debug
    sentiment_raw_label: str       # debug: raw classifier label
    sentiment_raw_score: float     # debug: classifier confidence


# ─── Scorer intermediate results ──────────────────────────────────────────────

@dataclass
class _ScorerResult:
    escalation_score:   float
    confidence:         float
    detected_signals:   set[str]   # rubric signal names that fired
    de_score:           float      # weighted sum of detected de-escalation signals
    esc_score:          float      # weighted sum of detected escalation signals
    de_weight_total:    float      # sum of all de_escalation_rubric weights
    esc_weight_total:   float      # sum of all escalation_rubric weights
    raw_score_pre_clamp: float     # score before score_range clamping


# ─── BehaviourAnalyser ────────────────────────────────────────────────────────

class BehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Production implementation. Loads models at construction time.
    All inference is async-safe via run_in_executor.
    """

    analyser_id = "production"

    def __init__(self, cfg: EvaluationConfig) -> None:
        import torch
        from transformers import pipeline, AutoProcessor, AutoModelForAudioClassification

        # Load implementation-specific tuning config (thresholds + lexical patterns).
        # The path defaults to evaluation_config.toml alongside the container's .env;
        # override with EVALUATION_CONFIG if the file lives elsewhere.
        _env_dir = Path(__file__).parent.parent
        toml_path = Path(os.environ.get("EVALUATION_CONFIG") or str(_env_dir / "evaluation_config.toml"))
        self._thresholds, self._lexical_config = _load_analyser_config(toml_path)

        self._device_str   = cfg.device
        self._torch_device = torch.device("cuda" if cfg.device == "cuda" else "cpu")
        self._executor     = ThreadPoolExecutor(
            max_workers        = 4,
            thread_name_prefix = "eval-worker",
        )

        logger.info(
            "Loading evaluation models on device=%s (emotion=%s, sentiment=%s)",
            cfg.device, cfg.emotion_model, cfg.sentiment_model,
        )

        # Stage A — dimensional emotion model
        # Outputs arousal, dominance, valence as continuous values.
        self._emotion_processor = AutoProcessor.from_pretrained(cfg.emotion_model)
        self._emotion_model = AutoModelForAudioClassification.from_pretrained(
            cfg.emotion_model,
        ).to(self._torch_device)
        self._emotion_model.eval()

        # Stage C — multilingual sentiment classifier
        # Outputs negative / neutral / positive.
        self._sentiment_pipeline = pipeline(
            "text-classification",
            model      = cfg.sentiment_model,
            device     = 0 if cfg.device == "cuda" else -1,
            truncation = True,
            max_length = 512,
        )

        # Stage C — compile lexical patterns from the loaded phrase lists.
        # Each phrase is compiled with word-boundary anchors so partial words
        # do not match. Multi-word phrases work correctly with this approach.
        self._lexical_patterns: list[tuple[str, re.Pattern]] = []
        lm = self._lexical_config
        for phrase in lm.empathy_phrases:
            self._lexical_patterns.append(
                ("empathy_phrase", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lm.open_question_phrases:
            self._lexical_patterns.append(
                ("open_question", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lm.validation_phrases:
            self._lexical_patterns.append(
                ("validation", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )

        logger.info(
            "Evaluation models loaded — %d lexical patterns compiled",
            len(self._lexical_patterns),
        )

    # ── Public API ────────────────────────────────────────────────────────────

    async def analyse(
        self,
        window: AnalysisWindow,
        *,
        collect_debug: bool = False,
    ) -> tuple[BehaviourResult, DebugStages | None]:
        loop = asyncio.get_running_loop()

        # Stages A, B, C run concurrently.
        audio_task = loop.run_in_executor(
            self._executor, self._stage_a, window.mfccs,
        )
        landmark_task = loop.run_in_executor(
            self._executor, self._stage_b, window.frames,
        )
        transcript_task = loop.run_in_executor(
            self._executor, self._stage_c, window.transcript, window.words,
            window.clip_metadata.clip_duration_seconds,
        )

        audio_result, landmark_result, transcript_result = await asyncio.gather(
            audio_task, landmark_task, transcript_task,
        )

        signal_summary = SignalSummary(
            vocal_tension      = audio_result.vocal_tension,
            speech_pace        = transcript_result.speech_pace,
            gesture_activity   = landmark_result.gesture_activity,
            open_gesture_ratio = landmark_result.open_gesture_ratio,
            head_nod_frequency = landmark_result.head_nod_frequency,
            facing_ratio       = landmark_result.facing_ratio,
            silence_ratio      = transcript_result.silence_ratio,
            lexical_markers    = transcript_result.lexical_markers,
            response_tone      = transcript_result.response_tone,
            notable_signals    = landmark_result.notable_signals,
        )

        scorer_result = self._scorer(
            signal_summary = signal_summary,
            metadata       = window.clip_metadata,
        )

        result = BehaviourResult(
            window_id        = window.window_id,
            session_id       = window.session_id,
            escalation_score = scorer_result.escalation_score,
            dominant_emotion = audio_result.dominant_emotion,
            confidence       = scorer_result.confidence,
            signal_summary   = signal_summary,
        )

        stages: DebugStages | None = None
        if collect_debug:
            stages = self._build_debug_stages(
                audio_result, landmark_result, transcript_result, scorer_result,
            )

        return result, stages

    # ── Stage A — Audio Emotion Extraction ───────────────────────────────────

    def _stage_a(self, mfccs: list[list[float]]) -> _AudioEmotionResult:
        """
        Convert MFCCs to approximate audio, run the dimensional emotion model,
        and derive vocal_tension from arousal + MFCC energy variance.

        Returns neutral/zero values when the MFCC matrix is empty (no audio).
        """
        import torch
        import librosa

        if not mfccs:
            return _AudioEmotionResult(
                arousal          = 0.5,
                valence          = 0.0,
                dominant_emotion = "neutral",
                vocal_tension    = 0.0,
                energy_var_norm  = 0.0,
            )

        mfcc_array = np.array(mfccs, dtype=np.float32)  # [n_frames, 13]
        mfcc_t     = mfcc_array.T                        # [13, n_frames]

        # Reconstruct approximate audio from MFCCs.
        # Griffin-Lim via librosa's inverse MFCC, 16 kHz.
        try:
            audio = librosa.feature.inverse.mfcc_to_audio(
                mfcc_t,
                sr       = 16_000,
                n_mels   = 128,
                n_iter   = 32,
            )
        except Exception as exc:
            logger.warning("MFCC→audio reconstruction failed: %s — using silence proxy", exc)
            audio = np.zeros(16_000, dtype=np.float32)

        # Normalise to float32 in [-1, 1].
        peak = np.abs(audio).max()
        if peak > 0:
            audio = audio / peak

        # Run dimensional emotion model.
        inputs = self._emotion_processor(
            audio,
            sampling_rate  = 16_000,
            return_tensors = "pt",
            padding        = True,
        )
        inputs = {k: v.to(self._torch_device) for k, v in inputs.items()}

        with torch.no_grad():
            outputs = self._emotion_model(**inputs)

        # audeering model outputs logits in order [arousal, dominance, valence].
        logits  = outputs.logits[0].cpu().float().numpy()
        arousal = float(np.clip(logits[0], 0.0, 1.0))
        valence = float(np.clip(logits[2], -1.0, 1.0))

        # MFCC energy variance as a secondary tension proxy.
        energy_per_frame = np.mean(mfcc_array ** 2, axis=1)
        energy_var       = float(np.var(energy_per_frame))
        # Normalise variance to [0, 1] using a soft sigmoid-like mapping.
        energy_var_norm  = float(1.0 / (1.0 + math.exp(-10.0 * (energy_var - 0.1))))

        # Combine arousal and energy variance; arousal is the dominant signal.
        vocal_tension = float(np.clip(0.7 * arousal + 0.3 * energy_var_norm, 0.0, 1.0))

        dominant_emotion = _arousal_valence_to_emotion(arousal, valence)

        return _AudioEmotionResult(
            arousal          = arousal,
            valence          = valence,
            dominant_emotion = dominant_emotion,
            vocal_tension    = vocal_tension,
            energy_var_norm  = energy_var_norm,
        )

    # ── Stage B — Landmark Feature Extraction ────────────────────────────────

    def _stage_b(self, frames: list) -> _LandmarkResult:
        """
        Extract gesture_activity, open_gesture_ratio, head_nod_frequency,
        and facing_ratio from VideoFrame landmark arrays.

        All computation is deterministic signal processing — no model needed.
        Returns zero/None values when frames are empty.
        """
        notable: list[str] = []

        if not frames:
            return _LandmarkResult(
                gesture_activity     = 0.0,
                open_gesture_ratio   = None,
                head_nod_frequency   = 0.0,
                facing_ratio         = 0.0,
                hands_detected_ratio = 0.0,
                facing_frame_count   = 0,
                total_frame_count    = 0,
                nod_fft_peak_hz      = 0.0,
                notable_signals      = ["no_frames"],
            )

        n_frames = len(frames)

        # ── Gesture activity (wrist + fingertip displacement variance) ────────
        all_displacements: list[float] = []
        prev_points: dict[str, np.ndarray] = {}

        for frame in frames:
            for side, landmarks in [("L", frame.left_hand), ("R", frame.right_hand)]:
                if not landmarks:
                    continue
                indices = [_WRIST_INDEX] + _FINGERTIP_INDICES
                pts = np.array([
                    [landmarks[i].x, landmarks[i].y]
                    for i in indices if i < len(landmarks)
                ], dtype=np.float32)
                if pts.size == 0:
                    continue
                key = f"hand_{side}"
                if key in prev_points:
                    delta = np.linalg.norm(pts - prev_points[key], axis=1)
                    all_displacements.extend(delta.tolist())
                prev_points[key] = pts

        gesture_activity = float(np.var(all_displacements)) if all_displacements else 0.0

        # ── Hand detection ratio + open gesture ratio ─────────────────────────
        n_hand_detected = sum(
            1 for f in frames if f.left_hand or f.right_hand
        )
        hands_detected_ratio = n_hand_detected / n_frames

        if hands_detected_ratio >= _MIN_HAND_DETECTION_RATIO:
            open_count   = 0
            total_hand_f = 0
            for frame in frames:
                for landmarks in [frame.left_hand, frame.right_hand]:
                    if not landmarks or len(landmarks) < 21:
                        continue
                    total_hand_f += 1
                    if _is_open_hand(landmarks):
                        open_count += 1
            open_gesture_ratio = (open_count / total_hand_f) if total_hand_f > 0 else None
        else:
            open_gesture_ratio = None
            notable.append("no_hands_detected")

        # ── Head nod frequency (Y-oscillation peak frequency) ─────────────────
        nose_y_values: list[float] = []
        for frame in frames:
            fl = frame.face_landmarks
            if fl and len(fl) > max(_NOSE_TIP_INDEX, _FOREHEAD_INDEX):
                y_nose = fl[_NOSE_TIP_INDEX].y
                y_fore = fl[_FOREHEAD_INDEX].y
                nose_y_values.append((y_nose + y_fore) / 2.0)

        nod_fft_peak_hz    = _compute_peak_frequency(nose_y_values, fps=30.0)
        head_nod_frequency = nod_fft_peak_hz

        # ── Facing ratio (face mesh lateral symmetry) ─────────────────────────
        # Uses MediaPipe face mesh cheekbone/ear-region landmarks to estimate
        # whether the student is facing the camera. When facing forward, left
        # and right landmarks are roughly equidistant from centre; when turned,
        # they cluster to one side.
        facing_count = 0
        facing_total = 0
        max_idx = max(_FACE_LEFT_INDICES + _FACE_RIGHT_INDICES)
        for frame in frames:
            fl = frame.face_landmarks
            if not fl or len(fl) <= max_idx:
                continue
            facing_total += 1
            left_x  = np.mean([fl[i].x for i in _FACE_LEFT_INDICES])
            right_x = np.mean([fl[i].x for i in _FACE_RIGHT_INDICES])
            # In normalised image coordinates the face centre is ~0.5.
            # When facing forward: left_x < 0.5 < right_x, spread is large.
            # When turned: both landmarks cluster on one side.
            spread       = abs(right_x - left_x)
            centre       = (left_x + right_x) / 2.0
            is_symmetric = spread > 0.15 and 0.3 < centre < 0.7
            if is_symmetric:
                facing_count += 1

        facing_ratio = (facing_count / facing_total) if facing_total > 0 else 0.5

        return _LandmarkResult(
            gesture_activity     = gesture_activity,
            open_gesture_ratio   = open_gesture_ratio,
            head_nod_frequency   = head_nod_frequency,
            facing_ratio         = facing_ratio,
            hands_detected_ratio = hands_detected_ratio,
            facing_frame_count   = facing_count,
            total_frame_count    = n_frames,
            nod_fft_peak_hz      = nod_fft_peak_hz,
            notable_signals      = notable,
        )

    # ── Stage C — Transcript Feature Extraction ───────────────────────────────

    def _stage_c(
        self,
        transcript:      str,
        words:           list[WordTiming],
        clip_duration_s: float,
    ) -> _TranscriptResult:
        """
        Compute silence_ratio, speech_pace, lexical_markers, and response_tone
        from the student's transcript and word timings.

        lexical_markers carries rubric category labels ("empathy_phrase",
        "open_question", "validation"), not raw matched text. This allows the
        scorer to add them directly to the detected-signals set without any
        re-parsing. Each category appears at most once.
        """
        # ── Silence ratio and speech pace ─────────────────────────────────────
        if words:
            speech_duration  = sum(max(0.0, w.end - w.start) for w in words)
            silence_duration = max(0.0, clip_duration_s - speech_duration)
            silence_ratio    = float(np.clip(silence_duration / clip_duration_s, 0.0, 1.0))
            syllable_count   = sum(_count_syllables_nl(w.word) for w in words)
            speech_pace      = float(syllable_count / speech_duration) if speech_duration > 0 else 0.0
            word_count       = len(words)
        else:
            # Fallback when word timings are unavailable (stub pool).
            speech_duration  = 0.0
            silence_duration = clip_duration_s
            if transcript.strip():
                syllable_count = _count_syllables_nl(transcript)
                speech_pace    = float(syllable_count / clip_duration_s) if clip_duration_s > 0 else 0.0
                silence_ratio  = 0.0
                silence_duration = 0.0
            else:
                syllable_count = 0
                speech_pace    = 0.0
                silence_ratio  = 1.0
            word_count = len(transcript.split()) if transcript.strip() else 0

        # ── Lexical de-escalation markers ─────────────────────────────────────
        # Emit category labels, not raw text. Duplicates collapsed.
        detected_categories: set[str] = set()
        for category, pattern in self._lexical_patterns:
            if pattern.search(transcript):
                detected_categories.add(category)
        lexical_markers = sorted(detected_categories)  # deterministic order

        # ── Response tone (sentiment classifier) ──────────────────────────────
        sentiment_raw_label = "neutral"
        sentiment_raw_score = 1.0
        if transcript.strip():
            try:
                result              = self._sentiment_pipeline(transcript[:512])
                sentiment_raw_label = result[0]["label"]
                sentiment_raw_score = float(result[0]["score"])
                response_tone       = _normalise_sentiment_label(sentiment_raw_label)
            except Exception as exc:
                logger.warning("Sentiment classification failed: %s", exc)
                response_tone = "neutral"
        else:
            response_tone = "neutral"

        return _TranscriptResult(
            speech_pace         = speech_pace,
            silence_ratio       = silence_ratio,
            lexical_markers     = lexical_markers,
            response_tone       = response_tone,
            speech_duration_s   = speech_duration,
            silence_duration_s  = silence_duration,
            word_count          = word_count,
            syllable_count      = syllable_count,
            sentiment_raw_label = sentiment_raw_label,
            sentiment_raw_score = sentiment_raw_score,
        )

    # ── Scorer Stage ──────────────────────────────────────────────────────────

    def _scorer(
        self,
        signal_summary: SignalSummary,
        metadata,               # ClipMetadata — avoiding circular import in type hint
    ) -> _ScorerResult:
        """
        Map computed signals to rubric entries, apply weighted scoring,
        and return a _ScorerResult with all intermediate values.

        In "rubric" mode: (esc_score - de_score) / total_weight, normalised.
        In "threshold" mode: only penalise clearly escalating signals; absence
          of positive signals is not penalised.

        Confidence reflects the fraction of rubric signals that had a reliable
        measurement. Hand-based signals reduce confidence when hands were
        off-camera.
        """
        ss = signal_summary
        t  = self._thresholds

        # ── Map computed signals to rubric vocabulary ──────────────────────────
        detected: set[str] = set()

        # vocal_tension → calm_voice / raised_voice
        if ss.vocal_tension <= t.calm_voice_tension_threshold:
            detected.add("calm_voice")
        elif ss.vocal_tension >= t.raised_voice_tension_threshold:
            detected.add("raised_voice")

        # speech_pace → measured_pace / fast_speech
        if ss.speech_pace > 0:
            if ss.speech_pace <= t.measured_pace_threshold:
                detected.add("measured_pace")
            elif ss.speech_pace >= t.fast_speech_pace_threshold:
                detected.add("fast_speech")

        # open_gesture_ratio → open_gesture / closed_gesture (only when available)
        if ss.open_gesture_ratio is not None:
            if ss.open_gesture_ratio >= t.open_gesture_threshold:
                detected.add("open_gesture")
            elif ss.open_gesture_ratio <= t.closed_gesture_threshold:
                detected.add("closed_gesture")

        # head_nod_frequency → active_listening
        if ss.head_nod_frequency >= t.nod_frequency_threshold:
            detected.add("active_listening")

        # facing_ratio → open_posture / turning_away
        if ss.facing_ratio >= t.open_posture_threshold:
            detected.add("open_posture")
        elif ss.facing_ratio <= t.turning_away_threshold:
            detected.add("turning_away")

        # silence_ratio → appropriate_silence / long_silence
        if t.appropriate_silence_min <= ss.silence_ratio <= t.appropriate_silence_max:
            detected.add("appropriate_silence")
        elif ss.silence_ratio >= t.long_silence_threshold:
            detected.add("long_silence")

        # lexical_markers — already rubric category labels; add directly.
        # Add "no_empathy" when none of the lexical categories were detected.
        for marker in ss.lexical_markers:
            detected.add(marker)
        if not any(m in ss.lexical_markers for m in ("empathy_phrase", "open_question", "validation")):
            detected.add("no_empathy")

        # response_tone → positive_tone / negative_tone
        if ss.response_tone == "positive":
            detected.add("positive_tone")
        elif ss.response_tone == "negative":
            detected.add("negative_tone")

        # ── Compute weighted score ─────────────────────────────────────────────
        de_rubric  = metadata.de_escalation_rubric
        esc_rubric = metadata.escalation_rubric

        de_score  = sum(e.weight for e in de_rubric  if e.signal in detected)
        esc_score = sum(e.weight for e in esc_rubric if e.signal in detected)

        de_total     = sum(e.weight for e in de_rubric)
        esc_total    = sum(e.weight for e in esc_rubric)
        total_weight = de_total + esc_total

        if total_weight == 0:
            raw_score = 0.0
        elif metadata.scoring_mode == "threshold":
            raw_score = esc_score / esc_total if esc_total > 0 else 0.0
        else:
            raw_score = (esc_score - de_score) / total_weight

        raw_score_pre_clamp = raw_score

        # ── Apply critical_failures penalty ───────────────────────────────────
        notable_additions: list[str] = []
        for sig in metadata.critical_failures:
            if sig in detected:
                raw_score = min(raw_score + 0.4, 1.0)
                notable_additions.append(f"critical_failure:{sig}")
                logger.debug("critical_failure triggered: %s", sig)

        if notable_additions:
            ss.notable_signals.extend(notable_additions)

        # ── Clamp to score_range ───────────────────────────────────────────────
        score = float(np.clip(raw_score, metadata.score_range.min, metadata.score_range.max))

        # ── Confidence ────────────────────────────────────────────────────────
        hand_signals         = {"open_gesture", "closed_gesture"}
        unavailable          = 0
        total_rubric_signals = len(de_rubric) + len(esc_rubric)

        if ss.open_gesture_ratio is None:
            unavailable += sum(
                1 for e in (list(de_rubric) + list(esc_rubric))
                if e.signal in hand_signals
            )

        if not metadata.de_escalation_rubric and not metadata.escalation_rubric:
            confidence = 1.0
        elif total_rubric_signals > 0:
            confidence = float(1.0 - (unavailable / total_rubric_signals))
        else:
            confidence = 1.0

        confidence = float(np.clip(confidence, 0.0, 1.0))

        return _ScorerResult(
            escalation_score    = score,
            confidence          = confidence,
            detected_signals    = detected,
            de_score            = de_score,
            esc_score           = esc_score,
            de_weight_total     = de_total,
            esc_weight_total    = esc_total,
            raw_score_pre_clamp = raw_score_pre_clamp,
        )

    # ── Debug stages builder ──────────────────────────────────────────────────

    def _build_debug_stages(
        self,
        audio:      _AudioEmotionResult,
        landmark:   _LandmarkResult,
        transcript: _TranscriptResult,
        scorer:     _ScorerResult,
    ) -> DebugStages:
        """
        Assemble the debug stages dict from the four intermediate results.
        Only called when collect_debug=True (admin sessions).
        Shape matches docs/admin_and_tooling_api.md → "stages for analyser_id: production".
        """
        return {
            "stage_a_audio_emotion": {
                "audio_emotion_label": audio.dominant_emotion,
                "arousal":             audio.arousal,
                "valence":             audio.valence,
                "energy_var_norm":     audio.energy_var_norm,
            },
            "stage_b_landmark_features": {
                "hands_detected_ratio": landmark.hands_detected_ratio,
                "gesture_activity":     landmark.gesture_activity,
                "facing_frame_count":   landmark.facing_frame_count,
                "total_frame_count":    landmark.total_frame_count,
                "nod_fft_peak_hz":      landmark.nod_fft_peak_hz,
            },
            "stage_c_transcript_features": {
                "speech_duration_s":   transcript.speech_duration_s,
                "silence_duration_s":  transcript.silence_duration_s,
                "word_count":          transcript.word_count,
                "syllable_count":      transcript.syllable_count,
                "sentiment_raw_label": transcript.sentiment_raw_label,
                "sentiment_raw_score": transcript.sentiment_raw_score,
            },
            "scorer": {
                "detected_signals":    sorted(scorer.detected_signals),
                "de_score":            scorer.de_score,
                "esc_score":           scorer.esc_score,
                "de_weight_total":     scorer.de_weight_total,
                "esc_weight_total":    scorer.esc_weight_total,
                "raw_score_pre_clamp": scorer.raw_score_pre_clamp,
            },
        }

    # ── Debug config accessor ─────────────────────────────────────────────────

    def debug_config(self) -> dict:
        """
        Return the active threshold and lexical config for GET /evaluate/debug/config.
        Only called by the route handler on the production analyser.
        """
        t  = self._thresholds
        lm = self._lexical_config
        return {
            "signal_thresholds": {
                "vocal_tension_high":       t.raised_voice_tension_threshold,
                "vocal_tension_low":        t.calm_voice_tension_threshold,
                "speech_pace_high":         t.fast_speech_pace_threshold,
                "speech_pace_low":          t.measured_pace_threshold,
                "silence_ratio_high":       t.long_silence_threshold,
                "silence_ratio_mid_min":    t.appropriate_silence_min,
                "silence_ratio_mid_max":    t.appropriate_silence_max,
                "head_nod_frequency_min":   t.nod_frequency_threshold,
                "facing_ratio_low":         t.turning_away_threshold,
                "facing_ratio_high":        t.open_posture_threshold,
                "open_gesture_ratio_low":   t.closed_gesture_threshold,
                "open_gesture_ratio_high":  t.open_gesture_threshold,
                "hands_detected_min_ratio": _MIN_HAND_DETECTION_RATIO,
            },
            "lexical_marker_phrases": {
                "empathy_acknowledgements": lm.empathy_phrases,
                "validation_phrases":       lm.validation_phrases,
                "open_question_patterns":   lm.open_question_phrases,
            },
        }


# ─── Pure helpers ─────────────────────────────────────────────────────────────

def _is_open_hand(landmarks: list) -> bool:
    """
    Return True if the hand appears to be open (fingers extended).
    Uses the relative y-position of each finger's MCP (base) vs tip landmark.
    In normalised image coordinates, a tip above its MCP (tip.y < mcp.y)
    indicates an extended finger. Checks all four non-thumb fingers.
    """
    finger_pairs = [(5, 8), (9, 12), (13, 16), (17, 20)]
    extended = 0
    for mcp_i, tip_i in finger_pairs:
        if mcp_i >= len(landmarks) or tip_i >= len(landmarks):
            continue
        if landmarks[tip_i].y < landmarks[mcp_i].y - 0.04:
            extended += 1
    return extended >= 3


def _compute_peak_frequency(values: list[float], fps: float = 30.0) -> float:
    """
    Estimate the dominant oscillation frequency (Hz) of a 1D signal using FFT.
    Returns 0.0 when the signal is too short or flat.
    Only considers physiologically plausible nod frequencies: 0.5–3 Hz.
    """
    if len(values) < 10:
        return 0.0

    y = np.array(values, dtype=np.float32)
    y -= y.mean()  # remove DC

    if np.std(y) < 1e-6:
        return 0.0

    if len(y) >= _NOD_SMOOTH_WINDOW:
        kernel = np.ones(_NOD_SMOOTH_WINDOW) / _NOD_SMOOTH_WINDOW
        y      = np.convolve(y, kernel, mode="same")

    fft_mag = np.abs(np.fft.rfft(y))
    freqs   = np.fft.rfftfreq(len(y), d=1.0 / fps)

    mask = (freqs >= 0.5) & (freqs <= 3.0)
    if not np.any(mask):
        return 0.0

    return float(freqs[mask][np.argmax(fft_mag[mask])])


def _count_syllables_nl(text: str) -> int:
    """
    Estimate syllable count for Dutch text using a vowel-group heuristic.
    Dutch syllables cluster around vowel groups (a, e, i, o, u, y).
    This is an approximation — consistent and fast, not exhaustive.
    """
    if not text:
        return 0
    count = len(re.findall(r"[aeiouy]+", text.lower()))
    return max(1, count)


def _arousal_valence_to_emotion(arousal: float, valence: float) -> str:
    """
    Map dimensional arousal/valence to a categorical emotion label using
    a simplified circumplex model.

    Quadrants:
      High arousal + negative valence → "frustrated" or "anxious"
      High arousal + positive valence → "calm" (animated but positive)
      Low arousal  + negative valence → "distressed"
      Low arousal  + positive valence → "calm"
    """
    if arousal >= 0.6:
        if valence < -0.2:
            return "frustrated"
        elif valence < 0.2:
            return "anxious"
        else:
            return "calm"
    elif arousal >= 0.35:
        return "anxious" if valence < -0.2 else "neutral"
    else:
        return "distressed" if valence < -0.2 else "calm"


def _normalise_sentiment_label(label: str) -> str:
    """
    Map the raw model label to the canonical response_tone vocabulary.
    cardiffnlp/twitter-xlm-roberta-base-sentiment outputs:
      "negative", "neutral", "positive"
    Some model variants output "LABEL_0/1/2" or star ratings.
    """
    label = label.lower().strip()
    if "neg" in label or label in ("label_0", "1 star", "2 stars"):
        return "negative"
    if "pos" in label or label in ("label_2", "4 stars", "5 stars"):
        return "positive"
    return "neutral"