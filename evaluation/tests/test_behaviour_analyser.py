"""
Tests for BehaviourAnalyser — the production evaluation pipeline.

These tests cover the deterministic parts of the pipeline (Stages B, C, and
the scorer) without loading real ML models. Stage A (audio emotion) is mocked
because it requires model weights and GPU/CPU inference.

The tests are organised by pipeline stage and scorer behaviour, with a small
integration section that exercises the full analyse() path end-to-end using
mocked model calls.

Run with:
    pytest tests/test_behaviour_analyser.py -v
"""

from __future__ import annotations

import asyncio
import math
import re
import sys
import os
from dataclasses import dataclass
from unittest.mock import MagicMock, patch, AsyncMock

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../src"))

from interfaces import (
    AnalysisWindow,
    BranchCondition,
    ClipMetadata,
    Landmark,
    RubricEntry,
    ScoreRange,
    SignalSummary,
    VideoFrame,
    WordTiming,
)

# Import the module-level helpers directly for unit testing — they are pure
# functions with no model dependency.
from behaviour_analyser import (
    _arousal_valence_to_emotion,
    _AudioEmotionResult,
    _compute_peak_frequency,
    _count_syllables_nl,
    _is_open_hand,
    _normalise_sentiment_label,
    BehaviourAnalyser,
)


# ─── Fixtures ──────────────────────────────────────────────────────────────────

def make_landmark(x: float = 0.5, y: float = 0.5, z: float = 0.0, vis: float = 1.0) -> Landmark:
    return Landmark(x=x, y=y, z=z, visibility=vis)


def make_hand_landmarks(open_hand: bool = True) -> list[Landmark]:
    """
    21 hand landmarks. For an open hand (fingers extended), tip.y < mcp.y.
    For a closed hand, tip.y >= mcp.y.
    """
    lm = [make_landmark() for _ in range(21)]
    # Finger MCP and tip pairs: (5,8), (9,12), (13,16), (17,20)
    for mcp_i, tip_i in [(5, 8), (9, 12), (13, 16), (17, 20)]:
        lm[mcp_i] = make_landmark(y=0.6)
        lm[tip_i] = make_landmark(y=0.5 if open_hand else 0.65)
    return lm


def make_face_landmarks_forward() -> list[Landmark]:
    """478 face landmarks where left and right cheek landmarks are symmetric."""
    lm = [make_landmark() for _ in range(478)]
    # Left cheek (234, 93) → x < 0.5
    lm[234] = make_landmark(x=0.3)
    lm[93]  = make_landmark(x=0.32)
    # Right cheek (454, 323) → x > 0.5
    lm[454] = make_landmark(x=0.7)
    lm[323] = make_landmark(x=0.68)
    # Nose tip (1) and forehead (10) for nod detection
    lm[1]  = make_landmark(y=0.5)
    lm[10] = make_landmark(y=0.35)
    return lm


def make_face_landmarks_turned() -> list[Landmark]:
    """478 face landmarks where both cheek landmarks are on the same side."""
    lm = [make_landmark() for _ in range(478)]
    # Both sides clustered left — student turned away
    lm[234] = make_landmark(x=0.2)
    lm[93]  = make_landmark(x=0.22)
    lm[454] = make_landmark(x=0.28)
    lm[323] = make_landmark(x=0.26)
    lm[1]   = make_landmark(y=0.5)
    lm[10]  = make_landmark(y=0.35)
    return lm


def make_frame(
    face_forward: bool = True,
    has_open_hands: bool = True,
    frame_id: int = 0,
) -> VideoFrame:
    face = make_face_landmarks_forward() if face_forward else make_face_landmarks_turned()
    hands = make_hand_landmarks(open_hand=has_open_hands)
    return VideoFrame(
        session_id     = "s1",
        frame_id       = frame_id,
        timestamp      = frame_id * 0.033,
        face_landmarks = face,
        left_hand      = hands,
        right_hand      = [],
    )


def make_clip_metadata(
    scoring_mode:         str                  = "rubric",
    de_escalation_rubric: list[RubricEntry]    = None,
    escalation_rubric:    list[RubricEntry]    = None,
    critical_failures:    list[str]            = None,
    score_range:          ScoreRange           = None,
    clip_duration_seconds: float               = 10.0,
) -> ClipMetadata:
    return ClipMetadata(
        clip_id               = "clip_01",
        scenario_id           = "scenario_01",
        transcript            = "actor dialogue",
        clip_duration_seconds = clip_duration_seconds,
        notable_features      = [],
        scoring_mode          = scoring_mode,
        de_escalation_rubric  = de_escalation_rubric or [],
        escalation_rubric     = escalation_rubric or [],
        critical_failures     = critical_failures or [],
        score_range           = score_range or ScoreRange(),
        branch_conditions     = [BranchCondition(-1.0, 1.01, None)],
    )


def make_window(
    frames:     list[VideoFrame] = None,
    mfccs:      list[list[float]] = None,
    transcript: str = "",
    words:      list[WordTiming] = None,
    metadata:   ClipMetadata = None,
) -> AnalysisWindow:
    return AnalysisWindow(
        window_id     = "s1:1",
        session_id    = "s1",
        frames        = frames or [],
        mfccs         = mfccs or [],
        transcript    = transcript,
        words         = words or [],
        clip_metadata = metadata or make_clip_metadata(),
    )


def _fixed_audio_result() -> _AudioEmotionResult:
    return _AudioEmotionResult(
        arousal          = 0.6,
        valence          = -0.3,
        dominant_emotion = "anxious",
        vocal_tension    = 0.7,
        energy_var_norm  = 0.4,
    )


# ─── Pure helper tests ────────────────────────────────────────────────────────

class TestCountSyllablesNl:
    def test_empty_string_returns_zero_or_positive(self):
        assert _count_syllables_nl("") == 0 or _count_syllables_nl("") >= 0

    def test_single_vowel_word(self):
        assert _count_syllables_nl("ik") == 1

    def test_multi_syllable_word(self):
        count = _count_syllables_nl("begrijpen")
        assert count >= 2

    def test_sentence(self):
        count = _count_syllables_nl("ik begrijp je")
        assert count >= 3

    def test_returns_positive(self):
        for word in ["hallo", "wereld", "de-escalatie", "calm"]:
            assert _count_syllables_nl(word) >= 1


class TestComputePeakFrequency:
    def test_empty_signal_returns_zero(self):
        assert _compute_peak_frequency([]) == 0.0

    def test_short_signal_returns_zero(self):
        assert _compute_peak_frequency([0.1, 0.2, 0.3]) == 0.0

    def test_flat_signal_returns_zero(self):
        assert _compute_peak_frequency([0.5] * 100) == 0.0

    def test_sinusoidal_signal_detects_frequency(self):
        fps    = 30.0
        freq   = 1.0
        n      = 90  # 3 seconds
        t      = np.linspace(0, n / fps, n)
        signal = np.sin(2 * np.pi * freq * t).tolist()
        result = _compute_peak_frequency(signal, fps=fps)
        assert abs(result - freq) < 0.5

    def test_result_within_physiological_range(self):
        fps    = 30.0
        freq   = 2.0
        n      = 120
        t      = np.linspace(0, n / fps, n)
        signal = np.sin(2 * np.pi * freq * t).tolist()
        result = _compute_peak_frequency(signal, fps=fps)
        assert 0.5 <= result <= 3.0


class TestIsOpenHand:
    def test_open_hand_returns_true(self):
        assert _is_open_hand(make_hand_landmarks(open_hand=True))

    def test_closed_hand_returns_false(self):
        assert not _is_open_hand(make_hand_landmarks(open_hand=False))

    def test_too_few_landmarks_does_not_raise(self):
        result = _is_open_hand([make_landmark()] * 5)
        assert isinstance(result, bool)


class TestArousalValenceToEmotion:
    def test_high_arousal_negative_valence_is_frustrated(self):
        assert _arousal_valence_to_emotion(0.8, -0.5) == "frustrated"

    def test_high_arousal_neutral_valence_is_anxious(self):
        assert _arousal_valence_to_emotion(0.8, 0.0) == "anxious"

    def test_high_arousal_positive_valence_is_calm(self):
        assert _arousal_valence_to_emotion(0.8, 0.5) == "calm"

    def test_low_arousal_negative_valence_is_distressed(self):
        assert _arousal_valence_to_emotion(0.1, -0.5) == "distressed"

    def test_low_arousal_positive_valence_is_calm(self):
        assert _arousal_valence_to_emotion(0.1, 0.5) == "calm"

    def test_mid_arousal_neutral_is_neutral(self):
        assert _arousal_valence_to_emotion(0.5, 0.0) == "neutral"


class TestNormaliseSentimentLabel:
    def test_negative_label(self):
        assert _normalise_sentiment_label("negative") == "negative"

    def test_positive_label(self):
        assert _normalise_sentiment_label("positive") == "positive"

    def test_neutral_label(self):
        assert _normalise_sentiment_label("neutral") == "neutral"

    def test_uppercase_handled(self):
        assert _normalise_sentiment_label("NEGATIVE") == "negative"

    def test_label_0_is_negative(self):
        assert _normalise_sentiment_label("label_0") == "negative"

    def test_label_2_is_positive(self):
        assert _normalise_sentiment_label("label_2") == "positive"

    def test_unknown_label_is_neutral(self):
        assert _normalise_sentiment_label("uncertain") == "neutral"


# ─── Stage B tests (no model) ─────────────────────────────────────────────────

class TestStageB:
    def _make_analyser(self) -> BehaviourAnalyser:
        with patch("behaviour_analyser.BehaviourAnalyser.__init__", return_value=None):
            analyser = BehaviourAnalyser.__new__(BehaviourAnalyser)
        return analyser

    def test_empty_frames_returns_zero_signals(self):
        analyser = self._make_analyser()
        result   = analyser._stage_b([])
        assert result.gesture_activity    == 0.0
        assert result.open_gesture_ratio  is None
        assert result.head_nod_frequency  == 0.0
        assert result.facing_ratio        == 0.0
        assert result.total_frame_count   == 0
        assert result.facing_frame_count  == 0
        assert "no_frames" in result.notable_signals

    def test_forward_facing_frames_have_high_facing_ratio(self):
        analyser = self._make_analyser()
        frames   = [make_frame(face_forward=True) for _ in range(20)]
        result   = analyser._stage_b(frames)
        assert result.facing_ratio > 0.5

    def test_turned_away_frames_have_low_facing_ratio(self):
        analyser = self._make_analyser()
        frames   = [make_frame(face_forward=False) for _ in range(20)]
        result   = analyser._stage_b(frames)
        assert result.facing_ratio < 0.5

    def test_open_hands_produce_high_open_gesture_ratio(self):
        analyser = self._make_analyser()
        frames   = [make_frame(has_open_hands=True) for _ in range(20)]
        result   = analyser._stage_b(frames)
        assert result.open_gesture_ratio is not None
        assert result.open_gesture_ratio > 0.5

    def test_closed_hands_produce_low_open_gesture_ratio(self):
        analyser = self._make_analyser()
        frames   = [make_frame(has_open_hands=False) for _ in range(20)]
        result   = analyser._stage_b(frames)
        assert result.open_gesture_ratio is not None
        assert result.open_gesture_ratio < 0.5

    def test_no_hands_produces_none_open_gesture_ratio(self):
        analyser = self._make_analyser()
        frames   = []
        for i in range(20):
            f = VideoFrame(
                session_id     = "s1",
                frame_id       = i,
                timestamp      = i * 0.033,
                face_landmarks = make_face_landmarks_forward(),
                left_hand      = [],
                right_hand     = [],
            )
            frames.append(f)
        result = analyser._stage_b(frames)
        assert result.open_gesture_ratio is None
        assert "no_hands_detected" in result.notable_signals

    def test_gesture_activity_is_zero_for_static_hands(self):
        analyser = self._make_analyser()
        frames   = [make_frame(has_open_hands=True) for _ in range(20)]
        result   = analyser._stage_b(frames)
        assert result.gesture_activity < 0.01

    def test_nodding_signal_detected_for_oscillating_y(self):
        analyser = self._make_analyser()
        frames = []
        for i in range(90):
            lm = make_face_landmarks_forward()
            lm[1]  = make_landmark(y=0.5 + 0.05 * math.sin(2 * math.pi * i / 30))
            lm[10] = make_landmark(y=0.35)
            f = VideoFrame(
                session_id     = "s1",
                frame_id       = i,
                timestamp      = i * 0.033,
                face_landmarks = lm,
                left_hand      = [],
                right_hand     = [],
            )
            frames.append(f)
        result = analyser._stage_b(frames)
        assert result.head_nod_frequency > 0.0

    def test_total_frame_count_matches_input(self):
        analyser = self._make_analyser()
        frames   = [make_frame() for _ in range(15)]
        result   = analyser._stage_b(frames)
        assert result.total_frame_count == 15

    def test_facing_frame_count_lte_total_frame_count(self):
        analyser = self._make_analyser()
        frames   = [make_frame(face_forward=True) for _ in range(10)]
        result   = analyser._stage_b(frames)
        assert result.facing_frame_count <= result.total_frame_count

    def test_nod_fft_peak_hz_matches_head_nod_frequency(self):
        analyser = self._make_analyser()
        frames   = [make_frame() for _ in range(30)]
        result   = analyser._stage_b(frames)
        assert result.nod_fft_peak_hz == result.head_nod_frequency


# ─── Stage C tests (sentiment model mocked) ───────────────────────────────────

class TestStageC:
    def _make_analyser(self, sentiment_label: str = "neutral") -> BehaviourAnalyser:
        from behaviour_analyser import _load_analyser_config
        from pathlib import Path
        toml_path = Path(__file__).parent.parent / "evaluation_config.toml"
        with patch("behaviour_analyser.BehaviourAnalyser.__init__", return_value=None):
            analyser = BehaviourAnalyser.__new__(BehaviourAnalyser)
        _, lexical = _load_analyser_config(toml_path)
        analyser._lexical_patterns = []
        for phrase in lexical.empathy_phrases:
            analyser._lexical_patterns.append(
                ("empathy_phrase", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lexical.open_question_phrases:
            analyser._lexical_patterns.append(
                ("open_question", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lexical.validation_phrases:
            analyser._lexical_patterns.append(
                ("validation", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        analyser._sentiment_pipeline = MagicMock(
            return_value=[{"label": sentiment_label, "score": 0.9}]
        )
        return analyser

    def test_empty_transcript_returns_neutral_tone(self):
        analyser = self._make_analyser()
        result   = analyser._stage_c("", [], 10.0)
        assert result.response_tone        == "neutral"
        assert result.speech_pace          == 0.0
        assert result.silence_ratio        == 1.0
        assert result.speech_duration_s    == 0.0
        assert result.word_count           == 0

    def test_non_empty_transcript_without_words_uses_clip_duration(self):
        analyser = self._make_analyser("neutral")
        result   = analyser._stage_c("hallo wereld", [], 10.0)
        assert result.speech_pace   > 0.0
        assert result.silence_ratio == 0.0

    def test_words_used_for_accurate_speech_pace(self):
        analyser = self._make_analyser("neutral")
        words = [
            WordTiming(word="hallo",  start=0.0, end=0.5),
            WordTiming(word="wereld", start=0.5, end=1.0),
        ]
        result = analyser._stage_c("hallo wereld", words, 10.0)
        assert result.speech_pace > 0.0
        assert abs(result.silence_ratio - 0.9) < 0.05

    def test_words_populate_debug_fields(self):
        analyser = self._make_analyser("neutral")
        words = [
            WordTiming(word="hallo",  start=0.0, end=0.5),
            WordTiming(word="wereld", start=0.5, end=1.0),
        ]
        result = analyser._stage_c("hallo wereld", words, 10.0)
        assert result.word_count          == 2
        assert result.speech_duration_s   == pytest.approx(1.0)
        assert result.silence_duration_s  == pytest.approx(9.0)
        assert result.syllable_count      >= 1

    def test_sentiment_raw_label_and_score_populated(self):
        analyser = self._make_analyser("positive")
        result   = analyser._stage_c("goed zo", [], 10.0)
        assert result.sentiment_raw_label == "positive"
        assert result.sentiment_raw_score == pytest.approx(0.9)

    def test_full_speech_clip_has_low_silence_ratio(self):
        analyser = self._make_analyser("neutral")
        words = [WordTiming(word="tekst", start=0.0, end=9.5)]
        result = analyser._stage_c("tekst", words, 10.0)
        assert result.silence_ratio < 0.1

    def test_empathy_phrase_detected(self):
        analyser = self._make_analyser("neutral")
        result   = analyser._stage_c("ik begrijp dat dit moeilijk is", [], 10.0)
        assert len(result.lexical_markers) > 0

    def test_open_question_detected(self):
        analyser = self._make_analyser("neutral")
        result   = analyser._stage_c("kun je me vertellen wat er is?", [], 10.0)
        assert len(result.lexical_markers) > 0

    def test_validation_detected(self):
        analyser = self._make_analyser("neutral")
        result   = analyser._stage_c("je hebt gelijk dat dit frustrerend is", [], 10.0)
        assert len(result.lexical_markers) > 0

    def test_no_markers_in_neutral_transcript(self):
        analyser = self._make_analyser("neutral")
        result   = analyser._stage_c("dit is gewoon een zin", [], 10.0)
        assert result.lexical_markers == []

    def test_positive_sentiment_label(self):
        analyser = self._make_analyser("positive")
        result   = analyser._stage_c("geweldig dat gaat goed", [], 10.0)
        assert result.response_tone == "positive"

    def test_negative_sentiment_label(self):
        analyser = self._make_analyser("negative")
        result   = analyser._stage_c("dit is helemaal fout", [], 10.0)
        assert result.response_tone == "negative"

    def test_sentiment_failure_falls_back_to_neutral(self):
        from behaviour_analyser import _load_analyser_config
        from pathlib import Path
        toml_path = Path(__file__).parent.parent / "evaluation_config.toml"
        with patch("behaviour_analyser.BehaviourAnalyser.__init__", return_value=None):
            analyser = BehaviourAnalyser.__new__(BehaviourAnalyser)
        _, lexical = _load_analyser_config(toml_path)
        analyser._lexical_patterns = []
        for phrase in lexical.empathy_phrases:
            analyser._lexical_patterns.append(
                ("empathy_phrase", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lexical.open_question_phrases:
            analyser._lexical_patterns.append(
                ("open_question", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lexical.validation_phrases:
            analyser._lexical_patterns.append(
                ("validation", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        analyser._sentiment_pipeline = MagicMock(side_effect=RuntimeError("model error"))
        result = analyser._stage_c("een transcript", [], 10.0)
        assert result.response_tone        == "neutral"
        assert result.sentiment_raw_label  == "neutral"


# ─── Scorer tests ─────────────────────────────────────────────────────────────

class TestScorer:
    def _make_analyser(self) -> BehaviourAnalyser:
        from behaviour_analyser import _load_analyser_config
        from pathlib import Path
        toml_path = Path(__file__).parent.parent / "evaluation_config.toml"
        with patch("behaviour_analyser.BehaviourAnalyser.__init__", return_value=None):
            analyser = BehaviourAnalyser.__new__(BehaviourAnalyser)
        thresholds, _ = _load_analyser_config(toml_path)
        analyser._thresholds = thresholds
        return analyser

    def _make_signal_summary(self, **kwargs) -> SignalSummary:
        defaults = dict(
            vocal_tension      = 0.4,
            speech_pace        = 3.0,
            gesture_activity   = 0.2,
            open_gesture_ratio = 0.7,
            head_nod_frequency = 0.3,
            facing_ratio       = 0.8,
            silence_ratio      = 0.2,
            lexical_markers    = [],
            response_tone      = "neutral",
            notable_signals    = [],
        )
        defaults.update(kwargs)
        return SignalSummary(**defaults)

    def test_no_rubric_returns_neutral_score(self):
        analyser = self._make_analyser()
        ss       = self._make_signal_summary()
        meta     = make_clip_metadata(de_escalation_rubric=[], escalation_rubric=[])
        scorer   = analyser._scorer(ss, meta)
        assert scorer.escalation_score == 0.0

    def test_scorer_returns_scorer_result(self):
        analyser = self._make_analyser()
        ss       = self._make_signal_summary()
        meta     = make_clip_metadata()
        from behaviour_analyser import _ScorerResult
        scorer = analyser._scorer(ss, meta)
        assert isinstance(scorer, _ScorerResult)

    def test_scorer_result_has_detected_signals(self):
        analyser = self._make_analyser()
        ss       = self._make_signal_summary()
        meta     = make_clip_metadata()
        scorer   = analyser._scorer(ss, meta)
        assert isinstance(scorer.detected_signals, set)

    def test_scorer_result_has_weight_totals(self):
        analyser = self._make_analyser()
        ss       = self._make_signal_summary()
        meta     = make_clip_metadata(
            de_escalation_rubric=[RubricEntry("calm_voice", 0.8)],
            escalation_rubric   =[RubricEntry("raised_voice", 1.0)],
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.de_weight_total  == pytest.approx(0.8)
        assert scorer.esc_weight_total == pytest.approx(1.0)

    def test_scorer_result_has_raw_score_pre_clamp(self):
        analyser = self._make_analyser()
        ss       = self._make_signal_summary()
        meta     = make_clip_metadata(
            escalation_rubric=[RubricEntry("raised_voice", 1.0)],
            score_range=ScoreRange(min=-1.0, max=0.1),
        )
        scorer = analyser._scorer(ss, meta)
        # raw_score_pre_clamp is the score before clamping; escalation_score is after
        assert isinstance(scorer.raw_score_pre_clamp, float)
        assert scorer.escalation_score <= 0.1

    def test_only_de_escalation_signals_detected_gives_negative_score(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(vocal_tension=0.2, lexical_markers=["ik begrijp"])
        meta = make_clip_metadata(
            de_escalation_rubric=[
                RubricEntry("calm_voice",    1.0),
                RubricEntry("empathy_phrase", 1.0),
            ],
            escalation_rubric=[],
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.escalation_score < 0.0

    def test_only_escalation_signals_detected_gives_positive_score(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(vocal_tension=0.8, response_tone="negative")
        meta = make_clip_metadata(
            de_escalation_rubric=[],
            escalation_rubric=[
                RubricEntry("raised_voice",  1.0),
                RubricEntry("negative_tone", 1.0),
            ],
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.escalation_score > 0.0

    def test_score_clamped_to_score_range_min(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(vocal_tension=0.2, lexical_markers=["ik begrijp"])
        meta = make_clip_metadata(
            de_escalation_rubric=[RubricEntry("calm_voice", 1.0)],
            escalation_rubric=[],
            score_range=ScoreRange(min=-0.3, max=1.0),
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.escalation_score >= -0.3

    def test_score_clamped_to_score_range_max(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(vocal_tension=0.8)
        meta = make_clip_metadata(
            de_escalation_rubric=[],
            escalation_rubric=[RubricEntry("raised_voice", 1.0)],
            score_range=ScoreRange(min=-1.0, max=0.2),
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.escalation_score <= 0.2

    def test_critical_failure_raises_score(self):
        analyser = self._make_analyser()
        ss_base = self._make_signal_summary(vocal_tension=0.8)
        meta_no_cf = make_clip_metadata(
            de_escalation_rubric=[RubricEntry("calm_voice",   1.0)],
            escalation_rubric   =[RubricEntry("raised_voice", 1.0)],
            critical_failures   =[],
        )
        scorer_no_cf = analyser._scorer(ss_base, meta_no_cf)

        ss_cf = self._make_signal_summary(vocal_tension=0.8, notable_signals=[])
        meta_cf = make_clip_metadata(
            de_escalation_rubric=[RubricEntry("calm_voice",   1.0)],
            escalation_rubric   =[RubricEntry("raised_voice", 1.0)],
            critical_failures   =["raised_voice"],
        )
        scorer_cf = analyser._scorer(ss_cf, meta_cf)
        assert scorer_cf.escalation_score > scorer_no_cf.escalation_score

    def test_critical_failure_appended_to_notable_signals(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(vocal_tension=0.8, notable_signals=[])
        meta = make_clip_metadata(
            de_escalation_rubric=[],
            escalation_rubric   =[RubricEntry("raised_voice", 1.0)],
            critical_failures   =["raised_voice"],
        )
        analyser._scorer(ss, meta)
        assert any("critical_failure:raised_voice" in s for s in ss.notable_signals)

    def test_threshold_mode_ignores_absent_positive_signals(self):
        # The defining property of threshold mode: absent positive signals do not
        # change the score. Two students with identical escalation behaviour but
        # different de-escalation behaviour must score the same in threshold mode
        # but differently in rubric mode.
        #
        # vocal_tension=0.3 → below calm_voice_tension_threshold (0.35) → calm_voice fires
        # vocal_tension=0.5 → between thresholds → neither calm_voice nor raised_voice fires
        # Neither student triggers raised_voice (threshold 0.65).
        analyser = self._make_analyser()

        meta_rubric = make_clip_metadata(
            scoring_mode         = "rubric",
            de_escalation_rubric = [RubricEntry("calm_voice",   1.0)],
            escalation_rubric    = [RubricEntry("raised_voice", 1.0)],
        )
        meta_threshold = make_clip_metadata(
            scoring_mode         = "threshold",
            de_escalation_rubric = [RubricEntry("calm_voice",   1.0)],
            escalation_rubric    = [RubricEntry("raised_voice", 1.0)],
        )

        # Student A: calm_voice fires (positive signal present)
        ss_with_positive    = self._make_signal_summary(vocal_tension=0.3)
        # Student B: neither signal fires (mid-range tension)
        ss_without_positive = self._make_signal_summary(vocal_tension=0.5)

        rubric_with    = analyser._scorer(ss_with_positive,    meta_rubric).escalation_score
        rubric_without = analyser._scorer(ss_without_positive, meta_rubric).escalation_score
        thresh_with    = analyser._scorer(ss_with_positive,    meta_threshold).escalation_score
        thresh_without = analyser._scorer(ss_without_positive, meta_threshold).escalation_score

        # Rubric mode rewards the positive signal: Student A scores lower than B
        assert rubric_with < rubric_without
        # Threshold mode ignores absent positives: both students score the same
        assert thresh_with == thresh_without

    def test_confidence_reduced_when_hands_off_camera(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(open_gesture_ratio=None)
        meta = make_clip_metadata(
            de_escalation_rubric=[
                RubricEntry("open_gesture", 1.0),
                RubricEntry("calm_voice",   1.0),
            ],
            escalation_rubric=[],
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.confidence < 1.0

    def test_confidence_full_when_all_signals_available(self):
        analyser = self._make_analyser()
        ss = self._make_signal_summary(open_gesture_ratio=0.7)
        meta = make_clip_metadata(
            de_escalation_rubric=[RubricEntry("calm_voice", 1.0)],
            escalation_rubric=[],
        )
        scorer = analyser._scorer(ss, meta)
        assert scorer.confidence == pytest.approx(1.0)


# ─── Debug stages builder tests ───────────────────────────────────────────────

class TestDebugStagesBuilder:
    def _make_analyser(self) -> BehaviourAnalyser:
        with patch("behaviour_analyser.BehaviourAnalyser.__init__", return_value=None):
            analyser = BehaviourAnalyser.__new__(BehaviourAnalyser)
        return analyser

    def _make_landmark_result(self):
        from behaviour_analyser import _LandmarkResult
        return _LandmarkResult(
            gesture_activity     = 0.3,
            open_gesture_ratio   = 0.7,
            head_nod_frequency   = 0.5,
            facing_ratio         = 0.8,
            hands_detected_ratio = 0.9,
            facing_frame_count   = 18,
            total_frame_count    = 20,
            nod_fft_peak_hz      = 0.5,
            notable_signals      = [],
        )

    def _make_transcript_result(self):
        from behaviour_analyser import _TranscriptResult
        return _TranscriptResult(
            speech_pace         = 3.2,
            silence_ratio       = 0.2,
            lexical_markers     = ["empathy_phrase"],
            response_tone       = "neutral",
            speech_duration_s   = 8.0,
            silence_duration_s  = 2.0,
            word_count          = 12,
            syllable_count      = 18,
            sentiment_raw_label = "neutral",
            sentiment_raw_score = 0.85,
        )

    def _make_scorer_result(self):
        from behaviour_analyser import _ScorerResult
        return _ScorerResult(
            escalation_score    = -0.3,
            confidence          = 0.9,
            detected_signals    = {"calm_voice", "empathy_phrase"},
            de_score            = 1.8,
            esc_score           = 0.0,
            de_weight_total     = 2.0,
            esc_weight_total    = 1.0,
            raw_score_pre_clamp = -0.3,
        )

    def test_build_debug_stages_returns_four_stage_keys(self):
        analyser = self._make_analyser()
        stages = analyser._build_debug_stages(
            _fixed_audio_result(),
            self._make_landmark_result(),
            self._make_transcript_result(),
            self._make_scorer_result(),
        )
        assert "stage_a_audio_emotion"       in stages
        assert "stage_b_landmark_features"   in stages
        assert "stage_c_transcript_features" in stages
        assert "scorer"                      in stages

    def test_stage_a_fields(self):
        analyser = self._make_analyser()
        stages = analyser._build_debug_stages(
            _fixed_audio_result(),
            self._make_landmark_result(),
            self._make_transcript_result(),
            self._make_scorer_result(),
        )
        a = stages["stage_a_audio_emotion"]
        assert a["arousal"]             == pytest.approx(0.6)
        assert a["valence"]             == pytest.approx(-0.3)
        assert a["audio_emotion_label"] == "anxious"
        assert "energy_var_norm"        in a

    def test_stage_b_fields(self):
        analyser = self._make_analyser()
        stages = analyser._build_debug_stages(
            _fixed_audio_result(),
            self._make_landmark_result(),
            self._make_transcript_result(),
            self._make_scorer_result(),
        )
        b = stages["stage_b_landmark_features"]
        assert b["facing_frame_count"]   == 18
        assert b["total_frame_count"]    == 20
        assert b["hands_detected_ratio"] == pytest.approx(0.9)
        assert "nod_fft_peak_hz"         in b

    def test_stage_c_fields(self):
        analyser = self._make_analyser()
        stages = analyser._build_debug_stages(
            _fixed_audio_result(),
            self._make_landmark_result(),
            self._make_transcript_result(),
            self._make_scorer_result(),
        )
        c = stages["stage_c_transcript_features"]
        assert c["word_count"]          == 12
        assert c["syllable_count"]      == 18
        assert c["sentiment_raw_label"] == "neutral"
        assert c["sentiment_raw_score"] == pytest.approx(0.85)
        assert c["speech_duration_s"]   == pytest.approx(8.0)
        assert c["silence_duration_s"]  == pytest.approx(2.0)

    def test_scorer_fields(self):
        analyser = self._make_analyser()
        stages = analyser._build_debug_stages(
            _fixed_audio_result(),
            self._make_landmark_result(),
            self._make_transcript_result(),
            self._make_scorer_result(),
        )
        sc = stages["scorer"]
        assert "calm_voice"      in sc["detected_signals"]
        assert "empathy_phrase"  in sc["detected_signals"]
        assert sc["de_score"]            == pytest.approx(1.8)
        assert sc["esc_score"]           == pytest.approx(0.0)
        assert sc["raw_score_pre_clamp"] == pytest.approx(-0.3)

    def test_detected_signals_is_sorted_list(self):
        analyser = self._make_analyser()
        stages = analyser._build_debug_stages(
            _fixed_audio_result(),
            self._make_landmark_result(),
            self._make_transcript_result(),
            self._make_scorer_result(),
        )
        detected = stages["scorer"]["detected_signals"]
        assert isinstance(detected, list)
        assert detected == sorted(detected)


# ─── Full analyse() integration (all models mocked) ──────────────────────────

class TestAnalyseIntegration:
    """
    End-to-end tests for analyse() with models replaced by mocks.
    Verifies that the pipeline wires correctly and produces a valid BehaviourResult.
    """

    def _make_analyser_with_mocks(self) -> BehaviourAnalyser:
        from behaviour_analyser import _load_analyser_config
        from pathlib import Path
        toml_path = Path(__file__).parent.parent / "evaluation_config.toml"
        with patch("behaviour_analyser.BehaviourAnalyser.__init__", return_value=None):
            analyser = BehaviourAnalyser.__new__(BehaviourAnalyser)

        thresholds, lexical = _load_analyser_config(toml_path)
        analyser._thresholds = thresholds

        import concurrent.futures
        analyser._executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)

        analyser._stage_a = MagicMock(return_value=_fixed_audio_result())

        analyser._lexical_patterns = []
        for phrase in lexical.empathy_phrases:
            analyser._lexical_patterns.append(
                ("empathy_phrase", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lexical.open_question_phrases:
            analyser._lexical_patterns.append(
                ("open_question", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )
        for phrase in lexical.validation_phrases:
            analyser._lexical_patterns.append(
                ("validation", re.compile(rf"\b{re.escape(phrase)}\b", re.IGNORECASE))
            )

        analyser._sentiment_pipeline = MagicMock(
            return_value=[{"label": "neutral", "score": 0.9}]
        )

        return analyser

    @pytest.mark.asyncio
    async def test_analyse_returns_tuple(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(metadata=make_clip_metadata())
        result   = await analyser.analyse(window)
        assert isinstance(result, tuple)
        assert len(result) == 2

    @pytest.mark.asyncio
    async def test_analyse_second_element_none_without_debug(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(metadata=make_clip_metadata())
        _, stages = await analyser.analyse(window)
        assert stages is None

    @pytest.mark.asyncio
    async def test_analyse_second_element_dict_with_debug(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(metadata=make_clip_metadata())
        _, stages = await analyser.analyse(window, collect_debug=True)
        assert isinstance(stages, dict)

    @pytest.mark.asyncio
    async def test_analyse_debug_stages_have_four_keys(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(metadata=make_clip_metadata())
        _, stages = await analyser.analyse(window, collect_debug=True)
        assert "stage_a_audio_emotion"       in stages
        assert "stage_b_landmark_features"   in stages
        assert "stage_c_transcript_features" in stages
        assert "scorer"                      in stages

    @pytest.mark.asyncio
    async def test_analyse_returns_behaviour_result(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(
            frames     = [make_frame()],
            transcript = "ik begrijp je frustratie",
            metadata   = make_clip_metadata(
                de_escalation_rubric=[RubricEntry("calm_voice",   0.8)],
                escalation_rubric   =[RubricEntry("raised_voice", 1.0)],
            ),
        )
        result, _ = await analyser.analyse(window)

        assert result.session_id  == "s1"
        assert result.window_id   == "s1:1"
        assert -1.0 <= result.escalation_score <= 1.0
        assert result.dominant_emotion in ("calm", "anxious", "frustrated", "neutral", "distressed")
        assert 0.0 <= result.confidence <= 1.0

    @pytest.mark.asyncio
    async def test_analyse_signal_summary_shape(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(transcript="hallo", metadata=make_clip_metadata())
        result, _ = await analyser.analyse(window)
        ss        = result.signal_summary

        assert isinstance(ss.vocal_tension,      float)
        assert isinstance(ss.speech_pace,        float)
        assert isinstance(ss.gesture_activity,   float)
        assert isinstance(ss.head_nod_frequency, float)
        assert isinstance(ss.facing_ratio,       float)
        assert isinstance(ss.silence_ratio,      float)
        assert isinstance(ss.lexical_markers,    list)
        assert ss.response_tone in ("positive", "neutral", "negative")

    @pytest.mark.asyncio
    async def test_analyse_empathy_phrase_in_lexical_markers(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window(
            transcript = "ik begrijp dat dit moeilijk voor je is",
            metadata   = make_clip_metadata(),
        )
        result, _ = await analyser.analyse(window)
        assert len(result.signal_summary.lexical_markers) > 0

    @pytest.mark.asyncio
    async def test_analyse_empty_window_does_not_raise(self):
        analyser = self._make_analyser_with_mocks()
        window   = make_window()
        result, stages = await analyser.analyse(window)
        assert result is not None
        assert stages is None

    @pytest.mark.asyncio
    async def test_analyse_respects_score_range(self):
        analyser = self._make_analyser_with_mocks()
        window = make_window(
            transcript = "dit is niet goed",
            metadata   = make_clip_metadata(
                escalation_rubric=[RubricEntry("raised_voice", 1.0)],
                score_range      = ScoreRange(min=-0.2, max=0.2),
            ),
        )
        result, _ = await analyser.analyse(window, collect_debug=False)
        assert -0.2 <= result.escalation_score <= 0.2