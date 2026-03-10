"""
Configuration loader for the Evaluation container.
Reads environment variables and returns a typed EvaluationConfig.
Mirrors the pattern in transcription/src/config.py.
"""
import os
import warnings
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# Load .env from the evaluation/ directory (one level up from src/).
# Has no effect when variables are already set in the environment (e.g. Docker).
load_dotenv(Path(__file__).parent.parent / ".env")

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise Exception(f"Missing required environment variable: {key}")
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
        raise RuntimeError(f"Environment variable {key} must be one of [{', '.join(allowed)}], got: {val!r}")
    return val

def _secret_env(key: str, known_bad_value: str = "CHANGE_ME") -> str:
    val = _require_env(key)
    if val == known_bad_value:
        warnings.warn(
            f"{key} is set to the default placeholder value. "
            "Generate a secure key with: openssl rand -hex 32",
            stacklevel=2,
        )
    return val

# ─── Config dataclass ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class EvaluationConfig:
    port:             int
    internal_api_key: str
    analyser_impl:    str   # "stub" | "production"
    device:           str   # "cpu" | "cuda"

def load_config() -> EvaluationConfig:
    return EvaluationConfig(
        port             = _int_env("PORT", 8001),
        internal_api_key = _secret_env("INTERNAL_API_KEY", "CHANGE_ME"),
        analyser_impl    = _enum_env("BEHAVIOUR_ANALYSER", ["stub", "production"], "stub"),
        device           = _enum_env("DEVICE", ["cpu", "cuda"], "cpu"),
    )