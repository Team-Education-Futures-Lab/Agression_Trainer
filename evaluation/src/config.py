"""
Configuration loader for the Evaluation container.
Reads environment variables and returns a typed EvaluationConfig.

Only infrastructure configuration lives here (device, API key, model names).
Implementation-specific tuning config (thresholds, lexical patterns) is the
responsibility of each BehaviourAnalyserInterface implementation and is loaded
directly by that implementation from evaluation_config.toml.
"""
from __future__ import annotations

import os
import warnings
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

_ENV_DIR = Path(__file__).parent.parent
load_dotenv(_ENV_DIR / ".env")


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise RuntimeError(f"Missing required environment variable: {key}")
    return val


def _int_env(key: str, fallback: int) -> int:
    val = os.environ.get(key)
    if not val:
        return fallback
    try:
        return int(val)
    except ValueError:
        raise RuntimeError(f"Environment variable {key} must be an integer, got {val!r}")


def _enum_env(key: str, allowed: list[str], fallback: str) -> str:
    val = os.environ.get(key)
    if not val:
        return fallback
    if val not in allowed:
        raise RuntimeError(
            f"Environment variable {key} must be one of [{', '.join(allowed)}], got: {val!r}"
        )
    return val


def _secret_env(key: str, known_bad_value: str = "CHANGE_ME") -> str:
    val = _require_env(key)
    if val == known_bad_value:
        warnings.warn(
            f"{key} is set to the default placeholder value. "
            "Generate a secure key with: openssl rand -hex 32",
            stacklevel=3,
        )
    return val


def _optional_env(key: str, fallback: str) -> str:
    return os.environ.get(key) or fallback


# ─── Config dataclass ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EvaluationConfig:
    port:             int
    internal_api_key: str
    analyser_impl:    str   # "stub" | "production"
    device:           str   # "cpu" | "cuda"
    """
    HuggingFace model ID for the multilingual text sentiment classifier.
    Used by Stage C of the production BehaviourAnalyser.
    Stage A (audio emotion) uses opensmile eGeMAPS features with no model
    download — no emotion_model field is needed.
    """
    sentiment_model: str


# ─── Public factory ───────────────────────────────────────────────────────────

def load_config() -> EvaluationConfig:
    return EvaluationConfig(
        port             = _int_env("PORT", 8001),
        internal_api_key = _secret_env("INTERNAL_API_KEY", "CHANGE_ME"),
        analyser_impl    = _enum_env("BEHAVIOUR_ANALYSER", ["stub", "production"], "stub"),
        device           = _enum_env("DEVICE", ["cpu", "cuda"], "cpu"),
        sentiment_model  = _optional_env(
            "SENTIMENT_MODEL",
            # distilbert multilingual sentiment — small, fast, ships safetensors.
            # Compatible with torch 2.5.x (no .bin loading required).
            "lxyuan/distilbert-base-multilingual-cased-sentiments-student",
        ),
    )