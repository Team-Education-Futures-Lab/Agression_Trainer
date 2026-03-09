"""
Configuration loader for the Transcription container.
Reads environment variables and returns a typed TranscriptionConfig.
Mirrors the secretEnv / requireEnv pattern in app/src/config.ts.
"""

from __future__ import annotations

import os
import warnings
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the transcription/ directory (one level up from src/).
# Has no effect when variables are already set in the environment (e.g. Docker),
# so this is safe to leave in for all environments.
load_dotenv(Path(__file__).parent.parent / ".env")

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
        raise RuntimeError(f"Environment variable {key} must be an integer, got: {val!r}")


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
    value = _require_env(key)
    if value == known_bad_value:
        warnings.warn(
            f"{key} is set to the default placeholder value. "
            "Generate a secure key with: openssl rand -hex 32",
            stacklevel=2,
        )
    return value


# ─── Config dataclass ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TranscriptionConfig:
    port:             int
    internal_api_key: str
    whisper_model:    str   # "tiny" | "base" | "small" | "medium" | "large-v3"
    whisper_language: str   # ISO 639-1, e.g. "nl"
    whisper_workers:  int   # Number of WhisperModel instances in the pool
    device:           str   # "cpu" | "cuda"
    pool_impl:        str   # "stub" | "production"


def load_config() -> TranscriptionConfig:
    return TranscriptionConfig(
        port             = _int_env("PORT", 8003),
        internal_api_key = _secret_env("INTERNAL_API_KEY", "CHANGE_ME"),
        whisper_model    = os.environ.get("WHISPER_MODEL", "base"),
        whisper_language = os.environ.get("WHISPER_LANGUAGE", "nl"),
        whisper_workers  = _int_env("WHISPER_WORKERS", 4),
        device           = _enum_env("DEVICE", ["cpu", "cuda"], "cpu"),
        pool_impl        = _enum_env("TRANSCRIPTION_POOL", ["stub", "production"], "stub"),
    )