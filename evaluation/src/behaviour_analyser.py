"""
Production implementation of BehaviourAnalyserInterface.

Runs the four-stage evaluation pipeline described in docs/architecture.md:

  Stage A — Audio Emotion / Prosodic Feature Extraction
    Input:  mfccs [n_frames][13] from AnalysisWindow
    Tool:   opensmile (eGeMAPS feature set)
    No model download required — feature definitions ship with the package.
    MFCCs are reconstructed to approximate audio via librosa Griffin-Lim,
    then opensmile extracts eGeMAPS prosodic features: F0 (pitch), energy,
    jitter, shimmer, HNR. These map directly to arousal/tension proxies.

  Stage B — Landmark Feature Extraction
    Input:  frames [VideoFrame] from AnalysisWindow
    Purely deterministic signal processing — no model or download needed.
    Extracts: gesture_activity, open_gesture_ratio, head_nod_frequency,
              facing_ratio.

  Stage C — Transcript Feature Extraction
    Input:  transcript (str) + words (WordTiming[]) from AnalysisWindow
    Model:  cardiffnlp/twitter-xlm-roberta-base-sentiment (via transformers
            pipeline). Downloaded on first use; cached in ~/.cache/huggingface.
    Rule-based: silence_ratio, speech_pace, lexical_markers.

  Scorer — Deterministic Weighted Scorer
    Maps computed signals to rubric entries, applies weights, computes
    escalation_score, clamps to score_range.

Stages A, B, C run concurrently via asyncio.gather; scorer runs after all
three complete.

All model/tool loading happens once at construction time so the container
fails fast on startup rather than on the first request.
All synchronous compute runs in a ThreadPoolExecutor so the asyncio event
loop is never blocked.
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
    pass

logger = logging.getLogger(__name__)

# ─── Implementation-detail constants ──────────────────────────────────────────

_FACE_LEFT_INDICES  = [234, 93]
_FACE_RIGHT_INDICES = [454, 323]
_WRIST_INDEX        = 0
_FINGERTIP_INDICES  = [4, 8, 12, 16, 20]
_NOSE_TIP_INDEX     = 1
_FOREHEAD_INDEX     = 10
_NOD_SMOOTH_WINDOW  = 5
_MIN_HAND_DETECTION_RATIO = 0.50

# Sample rate expected by opensmile and librosa reconstruction.
_SAMPLE_RATE = 16_000


# ─── TOML config dataclasses and loader ───────────────────────────────────────

@dataclass(frozen=True)
class _SignalThresholds:
    raised_voice_tension_threshold: float
    calm_voice_tension_threshold:   float
    fast_speech_pace_threshold:     float
    measured_pace_threshold:        float
    closed_gesture_threshold:       float
    open_gesture_threshold:         float
    nod_frequency_threshold:        float
    turning_away_threshold:         float
    open_posture_threshold:         float
    long_silence_threshold:         float
    appropriate_silence_min:        float
    appropriate_silence_max:        float


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
    if not path.exists():
        raise RuntimeError(
            f"BehaviourAnalyser tuning config not found: {path}\n"
            "Ensure evaluation_config.toml is present in the evaluation/ directory."
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


# ─── Stage intermediate result types ──────────────────────────────────────────

@dataclass
class _AudioResult:
    arousal:          float   # 0.0–1.0 derived from eGeMAPS energy/F0 features
    valence:          float   # -1.0–1.0 approximated from HNR and jitter
    dominant_emotion: str     # "calm" | "anxious" | "frustrated" | "neutral" | "distressed"
    vocal_tension:    float   # 0.0–1.0 fed to the scorer
    # debug fields
    f0_mean:          float
    f0_std:           float
    energy_mean:      float
    hnr_mean:         float


@dataclass
class _LandmarkResult:
    gesture_activity:     float
    open_gesture_ratio:   float | None
    head_nod_frequency:   float
    facing_ratio:         float
    hands_detected_ratio: float
    facing_frame_count:   int
    total_frame_count:    int
    nod_fft_peak_hz:      float
    notable_signals:      list[str]


@dataclass
class _TranscriptResult:
    speech_pace:         float
    silence_ratio:       float
    lexical_markers:     list[str]
    response_tone:       str
    speech_duration_s:   float
    silence_duration_s:  float
    word_count:          int
    syllable_count:      int
    sentiment_raw_label: str
    sentiment_raw_score: float


@dataclass
class _ScorerResult:
    escalation_score:    float
    confidence:          float
    detected_signals:    set[str]
    de_score:            float
    esc_score:           float
    de_weight_total:     float
    esc_weight_total:    float
    raw_score_pre_clamp: float


# ─── BehaviourAnalyser ────────────────────────────────────────────────────────

class BehaviourAnalyser(BehaviourAnalyserInterface):
    """
    Production implementation. Loads all tools at construction time.
    All compute is async-safe via run_in_executor.
    """

    analyser_id = "production"

    def __init__(self, cfg: EvaluationConfig) -> None:
        import opensmile
        from transformers import pipeline

        _env_dir  = Path(__file__).parent.parent
        toml_path = Path(
            os.environ.get("EVALUATION_CONFIG") or str(_env_dir / "evaluation_config.toml")
        )
        self._thresholds, self._lexical_config = _load_analyser_config(toml_path)

        self._device_str = cfg.device
        self._executor   = ThreadPoolExecutor(
            max_workers        = 4,
            thread_name_prefix = "eval-worker",
        )

        logger.info(
            "Loading evaluation tools on device=%s (sentiment=%s)",
            cfg.device, cfg.sentiment_model,
        )

        # Stage A — opensmile eGeMAPS feature extractor.
        # Ships with the opensmile package — no model download, no internet,
        # no HuggingFace dependency. eGeMAPS is the standard acoustic feature
        # set for speech emotion research: F0, energy, jitter, shimmer, HNR.
        self._smile = opensmile.Smile(
            feature_set  = opensmile.FeatureSet.eGeMAPSv02,
            feature_level= opensmile.FeatureLevel.Functionals,
        )

        # Stage C — multilingual sentiment classifier.
        # transformers + huggingface_hub pinned in requirements.txt to a
        # tested compatible pair; this model has no config.json issues.
        self._sentiment_pipeline = pipeline(
            "text-classification",
            model      = cfg.sentiment_model,
            device     = 0 if cfg.device == "cuda" else -1,
            truncation = True,
            max_length = 512,
        )

        # Stage C — compile lexical patterns once at startup.
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
            "Evaluation tools loaded — %d lexical patterns compiled",
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

        audio_task = loop.run_in_executor(
            self._executor, self._stage_a, window.mfccs,
        )
        landmark_task = loop.run_in_executor(
            self._executor, self._stage_b, window.frames,
        )
        transcript_task = loop.run_in_executor(
            self._executor, self._stage_c,
            window.transcript, window.words,
            window.clip_metadata.clip_duration_seconds,
        )

        audio_r, landmark_r, transcript_r = await asyncio.gather(
            audio_task, landmark_task, transcript_task,
        )

        signal_summary = SignalSummary(
            vocal_tension      = audio_r.vocal_tension,
            speech_pace        = transcript_r.speech_pace,
            gesture_activity   = landmark_r.gesture_activity,
            open_gesture_ratio = landmark_r.open_gesture_ratio,
            head_nod_frequency = landmark_r.head_nod_frequency,
            facing_ratio       = landmark_r.facing_ratio,
            silence_ratio      = transcript_r.silence_ratio,
            lexical_markers    = transcript_r.lexical_markers,
            response_tone      = transcript_r.response_tone,
            notable_signals    = landmark_r.notable_signals,
        )

        scorer_r = self._scorer(signal_summary, window.clip_metadata)

        result = BehaviourResult(
            window_id        = window.window_id,
            session_id       = window.session_id,
            escalation_score = scorer_r.escalation_score,
            dominant_emotion = audio_r.dominant_emotion,
            confidence       = scorer_r.confidence,
            signal_summary   = signal_summary,
        )

        stages: DebugStages | None = None
        if collect_debug:
            stages = self._build_debug_stages(audio_r, landmark_r, transcript_r, scorer_r)

        return result, stages

    # ── Stage A — Prosodic Feature Extraction ────────────────────────────────

    def _stage_a(self, mfccs: list[list[float]]) -> _AudioResult:
        """
        Reconstruct approximate audio from MFCCs, then run opensmile eGeMAPS
        to extract prosodic features. Map those features to arousal/tension.

        eGeMAPS functionals used:
          - F0semitoneFrom27.5Hz_sma3nz_*: pitch mean/std (arousal proxy)
          - loudness_sma3_*:               energy/loudness (tension proxy)
          - HNRdBACF_sma3nz_*:             harmonics-to-noise (voice quality)
          - jitterLocal_sma3nz_*:          pitch irregularity (stress marker)
          - shimmerLocaldB_sma3nz_*:       amplitude irregularity (stress marker)

        Returns a fallback neutral result when MFCCs are empty or feature
        extraction fails.
        """
        import librosa

        _neutral = _AudioResult(
            arousal=0.4, valence=0.0, dominant_emotion="neutral",
            vocal_tension=0.0, f0_mean=0.0, f0_std=0.0,
            energy_mean=0.0, hnr_mean=0.0,
        )

        if not mfccs:
            return _neutral

        mfcc_array = np.array(mfccs, dtype=np.float32)  # [n_frames, 13]

        # Reconstruct approximate audio from MFCCs via Griffin-Lim.
        try:
            audio = librosa.feature.inverse.mfcc_to_audio(
                mfcc_array.T,
                sr     = _SAMPLE_RATE,
                n_mels = 128,
                n_iter = 32,
            )
            peak = np.abs(audio).max()
            if peak > 1e-6:
                audio = (audio / peak).astype(np.float32)
            else:
                return _neutral
        except Exception as exc:
            logger.warning("MFCC→audio reconstruction failed: %s", exc)
            return _neutral

        # Extract eGeMAPS functionals with opensmile.
        try:
            features = self._smile.process_signal(audio, _SAMPLE_RATE)
            cols     = features.columns.tolist()
            row      = features.iloc[0]
        except Exception as exc:
            logger.warning("opensmile feature extraction failed: %s", exc)
            return _neutral

        def _feat(prefix: str) -> float:
            """Return the first eGeMAPS column whose name starts with prefix, or 0."""
            for c in cols:
                if c.startswith(prefix):
                    v = float(row[c])
                    return v if math.isfinite(v) else 0.0
            return 0.0

        f0_mean    = _feat("F0semitoneFrom27.5Hz_sma3nz_amean")
        f0_std     = _feat("F0semitoneFrom27.5Hz_sma3nz_stddevNorm")
        energy     = _feat("loudness_sma3_amean")
        hnr        = _feat("HNRdBACF_sma3nz_amean")
        jitter     = _feat("jitterLocal_sma3nz_amean")
        shimmer    = _feat("shimmerLocaldB_sma3nz_amean")

        # Map features to arousal (0–1) and valence (−1–1).
        # High energy + high F0 variation → high arousal (stressed/angry).
        # High HNR (clean, harmonic voice) → positive valence proxy.
        # High jitter/shimmer → voice irregularity → tension.
        energy_norm = float(np.clip(energy / 0.5, 0.0, 1.0))
        f0_var_norm = float(np.clip(f0_std / 30.0, 0.0, 1.0))
        jitter_norm = float(np.clip(jitter / 0.05, 0.0, 1.0))
        shimmer_norm= float(np.clip(shimmer / 3.0, 0.0, 1.0))
        hnr_norm    = float(np.clip(hnr / 25.0, 0.0, 1.0))  # 0 dB=noisy, 25 dB=clean

        arousal = float(np.clip(
            0.45 * energy_norm + 0.35 * f0_var_norm + 0.20 * jitter_norm,
            0.0, 1.0,
        ))
        # High HNR = clear/positive voice; low HNR + high shimmer = tense
        valence = float(np.clip(hnr_norm - shimmer_norm, -1.0, 1.0))

        # vocal_tension: primary driver is energy + jitter/shimmer stress markers
        vocal_tension = float(np.clip(
            0.50 * energy_norm + 0.25 * jitter_norm + 0.25 * shimmer_norm,
            0.0, 1.0,
        ))

        dominant_emotion = _arousal_valence_to_emotion(arousal, valence)

        return _AudioResult(
            arousal          = arousal,
            valence          = valence,
            dominant_emotion = dominant_emotion,
            vocal_tension    = vocal_tension,
            f0_mean          = f0_mean,
            f0_std           = f0_std,
            energy_mean      = energy,
            hnr_mean         = hnr,
        )

    # ── Stage B — Landmark Feature Extraction ────────────────────────────────

    def _stage_b(self, frames: list) -> _LandmarkResult:
        notable: list[str] = []

        if not frames:
            return _LandmarkResult(
                gesture_activity=0.0, open_gesture_ratio=None,
                head_nod_frequency=0.0, facing_ratio=0.0,
                hands_detected_ratio=0.0, facing_frame_count=0,
                total_frame_count=0, nod_fft_peak_hz=0.0,
                notable_signals=["no_frames"],
            )

        n_frames = len(frames)

        # ── Gesture activity ──────────────────────────────────────────────────
        all_displacements: list[float] = []
        prev_points: dict[str, np.ndarray] = {}

        for frame in frames:
            for side, landmarks in [("L", frame.left_hand), ("R", frame.right_hand)]:
                if not landmarks:
                    continue
                indices = [_WRIST_INDEX] + _FINGERTIP_INDICES
                pts = np.array(
                    [[landmarks[i].x, landmarks[i].y] for i in indices if i < len(landmarks)],
                    dtype=np.float32,
                )
                if pts.size == 0:
                    continue
                key = f"hand_{side}"
                if key in prev_points:
                    all_displacements.extend(
                        np.linalg.norm(pts - prev_points[key], axis=1).tolist()
                    )
                prev_points[key] = pts

        gesture_activity = float(np.var(all_displacements)) if all_displacements else 0.0

        # ── Hand detection ratio + open gesture ratio ─────────────────────────
        n_hand_detected      = sum(1 for f in frames if f.left_hand or f.right_hand)
        hands_detected_ratio = n_hand_detected / n_frames

        if hands_detected_ratio >= _MIN_HAND_DETECTION_RATIO:
            open_count = total_hand_f = 0
            for frame in frames:
                for landmarks in [frame.left_hand, frame.right_hand]:
                    if not landmarks or len(landmarks) < 21:
                        continue
                    total_hand_f += 1
                    if _is_open_hand(landmarks):
                        open_count += 1
            open_gesture_ratio: float | None = (
                (open_count / total_hand_f) if total_hand_f > 0 else None
            )
        else:
            open_gesture_ratio = None
            notable.append("no_hands_detected")

        # ── Head nod frequency ────────────────────────────────────────────────
        nose_y: list[float] = []
        for frame in frames:
            fl = frame.face_landmarks
            if fl and len(fl) > max(_NOSE_TIP_INDEX, _FOREHEAD_INDEX):
                nose_y.append((fl[_NOSE_TIP_INDEX].y + fl[_FOREHEAD_INDEX].y) / 2.0)

        nod_fft_peak_hz = _compute_peak_frequency(nose_y, fps=30.0)

        # ── Facing ratio ──────────────────────────────────────────────────────
        facing_count = facing_total = 0
        max_idx = max(_FACE_LEFT_INDICES + _FACE_RIGHT_INDICES)
        for frame in frames:
            fl = frame.face_landmarks
            if not fl or len(fl) <= max_idx:
                continue
            facing_total += 1
            left_x  = float(np.mean([fl[i].x for i in _FACE_LEFT_INDICES]))
            right_x = float(np.mean([fl[i].x for i in _FACE_RIGHT_INDICES]))
            if abs(right_x - left_x) > 0.15 and 0.3 < (left_x + right_x) / 2.0 < 0.7:
                facing_count += 1

        facing_ratio = (facing_count / facing_total) if facing_total > 0 else 0.5

        return _LandmarkResult(
            gesture_activity     = gesture_activity,
            open_gesture_ratio   = open_gesture_ratio,
            head_nod_frequency   = nod_fft_peak_hz,
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
        if words:
            speech_duration  = sum(max(0.0, w.end - w.start) for w in words)
            silence_duration = max(0.0, clip_duration_s - speech_duration)
            silence_ratio    = float(np.clip(silence_duration / clip_duration_s, 0.0, 1.0))
            syllable_count   = sum(_count_syllables_nl(w.word) for w in words)
            speech_pace      = float(syllable_count / speech_duration) if speech_duration > 0 else 0.0
            word_count       = len(words)
        else:
            speech_duration = silence_duration = 0.0
            if transcript.strip():
                syllable_count = _count_syllables_nl(transcript)
                speech_pace    = float(syllable_count / clip_duration_s) if clip_duration_s > 0 else 0.0
                silence_ratio  = 0.0
            else:
                syllable_count = 0
                speech_pace    = 0.0
                silence_ratio  = 1.0
                silence_duration = clip_duration_s
            word_count = len(transcript.split()) if transcript.strip() else 0

        detected_categories: set[str] = set()
        for category, pattern in self._lexical_patterns:
            if pattern.search(transcript):
                detected_categories.add(category)
        lexical_markers = sorted(detected_categories)

        sentiment_raw_label = "neutral"
        sentiment_raw_score = 1.0
        response_tone       = "neutral"
        if transcript.strip():
            try:
                res                 = self._sentiment_pipeline(transcript[:512])
                sentiment_raw_label = res[0]["label"]
                sentiment_raw_score = float(res[0]["score"])
                response_tone       = _normalise_sentiment_label(sentiment_raw_label)
            except Exception as exc:
                logger.warning("Sentiment classification failed: %s", exc)

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

    # ── Scorer ────────────────────────────────────────────────────────────────

    def _scorer(self, ss: SignalSummary, metadata) -> _ScorerResult:
        t = self._thresholds
        detected: set[str] = set()

        if ss.vocal_tension <= t.calm_voice_tension_threshold:
            detected.add("calm_voice")
        elif ss.vocal_tension >= t.raised_voice_tension_threshold:
            detected.add("raised_voice")

        if ss.speech_pace > 0:
            if ss.speech_pace <= t.measured_pace_threshold:
                detected.add("measured_pace")
            elif ss.speech_pace >= t.fast_speech_pace_threshold:
                detected.add("fast_speech")

        if ss.open_gesture_ratio is not None:
            if ss.open_gesture_ratio >= t.open_gesture_threshold:
                detected.add("open_gesture")
            elif ss.open_gesture_ratio <= t.closed_gesture_threshold:
                detected.add("closed_gesture")

        if ss.head_nod_frequency >= t.nod_frequency_threshold:
            detected.add("active_listening")

        if ss.facing_ratio >= t.open_posture_threshold:
            detected.add("open_posture")
        elif ss.facing_ratio <= t.turning_away_threshold:
            detected.add("turning_away")

        if t.appropriate_silence_min <= ss.silence_ratio <= t.appropriate_silence_max:
            detected.add("appropriate_silence")
        elif ss.silence_ratio >= t.long_silence_threshold:
            detected.add("long_silence")

        for marker in ss.lexical_markers:
            detected.add(marker)
        if not any(m in ss.lexical_markers for m in ("empathy_phrase", "open_question", "validation")):
            detected.add("no_empathy")

        if ss.response_tone == "positive":
            detected.add("positive_tone")
        elif ss.response_tone == "negative":
            detected.add("negative_tone")

        de_rubric  = metadata.de_escalation_rubric
        esc_rubric = metadata.escalation_rubric
        de_score   = sum(e.weight for e in de_rubric  if e.signal in detected)
        esc_score  = sum(e.weight for e in esc_rubric if e.signal in detected)
        de_total   = sum(e.weight for e in de_rubric)
        esc_total  = sum(e.weight for e in esc_rubric)
        total_w    = de_total + esc_total

        if total_w == 0:
            raw = 0.0
        elif metadata.scoring_mode == "threshold":
            raw = esc_score / esc_total if esc_total > 0 else 0.0
        else:
            raw = (esc_score - de_score) / total_w

        raw_pre_clamp = raw

        notable_additions: list[str] = []
        for sig in metadata.critical_failures:
            if sig in detected:
                raw = min(raw + 0.4, 1.0)
                notable_additions.append(f"critical_failure:{sig}")
                logger.debug("critical_failure triggered: %s", sig)
        if notable_additions:
            ss.notable_signals.extend(notable_additions)

        score = float(np.clip(raw, metadata.score_range.min, metadata.score_range.max))

        hand_signals         = {"open_gesture", "closed_gesture"}
        total_rubric_signals = len(de_rubric) + len(esc_rubric)
        unavailable          = 0
        if ss.open_gesture_ratio is None:
            unavailable = sum(
                1 for e in list(de_rubric) + list(esc_rubric) if e.signal in hand_signals
            )

        if total_rubric_signals == 0:
            confidence = 1.0
        else:
            confidence = float(np.clip(1.0 - (unavailable / total_rubric_signals), 0.0, 1.0))

        return _ScorerResult(
            escalation_score    = score,
            confidence          = confidence,
            detected_signals    = detected,
            de_score            = de_score,
            esc_score           = esc_score,
            de_weight_total     = de_total,
            esc_weight_total    = esc_total,
            raw_score_pre_clamp = raw_pre_clamp,
        )

    # ── Debug ─────────────────────────────────────────────────────────────────

    def _build_debug_stages(
        self,
        audio:      _AudioResult,
        landmark:   _LandmarkResult,
        transcript: _TranscriptResult,
        scorer:     _ScorerResult,
    ) -> DebugStages:
        return {
            "stage_a_audio_prosodic": {
                "dominant_emotion": audio.dominant_emotion,
                "arousal":          audio.arousal,
                "valence":          audio.valence,
                "vocal_tension":    audio.vocal_tension,
                "f0_mean":          audio.f0_mean,
                "f0_std":           audio.f0_std,
                "energy_mean":      audio.energy_mean,
                "hnr_mean":         audio.hnr_mean,
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

    def debug_config(self) -> dict:
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
    extended = 0
    for mcp_i, tip_i in [(5, 8), (9, 12), (13, 16), (17, 20)]:
        if mcp_i >= len(landmarks) or tip_i >= len(landmarks):
            continue
        if landmarks[tip_i].y < landmarks[mcp_i].y - 0.04:
            extended += 1
    return extended >= 3


def _compute_peak_frequency(values: list[float], fps: float = 30.0) -> float:
    if len(values) < 10:
        return 0.0
    y = np.array(values, dtype=np.float32)
    y -= y.mean()
    if np.std(y) < 1e-6:
        return 0.0
    if len(y) >= _NOD_SMOOTH_WINDOW:
        kernel = np.ones(_NOD_SMOOTH_WINDOW) / _NOD_SMOOTH_WINDOW
        y      = np.convolve(y, kernel, mode="same")
    fft_mag = np.abs(np.fft.rfft(y))
    freqs   = np.fft.rfftfreq(len(y), d=1.0 / fps)
    mask    = (freqs >= 0.5) & (freqs <= 3.0)
    if not np.any(mask):
        return 0.0
    return float(freqs[mask][np.argmax(fft_mag[mask])])


def _count_syllables_nl(text: str) -> int:
    if not text:
        return 0
    return max(1, len(re.findall(r"[aeiouy]+", text.lower())))


def _arousal_valence_to_emotion(arousal: float, valence: float) -> str:
    if arousal >= 0.6:
        return "frustrated" if valence < -0.2 else ("anxious" if valence < 0.2 else "calm")
    elif arousal >= 0.35:
        return "anxious" if valence < -0.2 else "neutral"
    else:
        return "distressed" if valence < -0.2 else "calm"


def _normalise_sentiment_label(label: str) -> str:
    label = label.lower().strip()
    if "neg" in label or label in ("label_0", "1 star", "2 stars"):
        return "negative"
    if "pos" in label or label in ("label_2", "4 stars", "5 stars"):
        return "positive"
    return "neutral"