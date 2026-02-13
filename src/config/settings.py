"""
Configuration management using environment variables.

Loads settings from .env file or environment variables.
Uses Pydantic for validation and type checking.
"""
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Project root directory
ROOT_DIR = Path(__file__).parent.parent.parent.resolve()
ASSETS_DIR = ROOT_DIR / "assets"
MODELS_DIR = ASSETS_DIR / "models"
SCENARIOS_DIR = ASSETS_DIR / "scenarios"
LOGGING_DIR = ROOT_DIR / "logging"

class Settings(BaseSettings):
    """
    Application settings loaded from environment variables.

    Automatically loads from .env file if present.
    Falls back to default values if not specified.
    """

    # ==================== Server Configuration ====================
    HOST: str = Field(
        default="0.0.0.0",
        description="Server host address"
    )

    PORT: int = Field(
        default=5000,
        ge=1024,
        le=65535,
        description="Server port number"
    )

    DEBUG: bool = Field(
        default=False,
        description="Enable debug mode"
    )

    # ==================== Database Configuration ====================
    DATABASE_URL: str = Field(
        default="postgresql://ar_training:password@localhost:5432/ar_training_db",
        description="PostgreSQL database url"
    )

    # ==================== Redis Configuration ====================
    REDIS_URL: str = Field(
        default="redis://localhost:6379/0",
        description="Redis url"
    )

    # ==================== AI Model Paths ====================
    EMOTION_MODEL_PATH: Path = Field(
        default=MODELS_DIR / "emotion_model.h5",
        description="Emotion model path"
    )

    GESTURE_MODEL_PATH: Path = Field(
        default=MODELS_DIR / "gesture_model.tflite",
        description="Gesture recognition model path"
    )

    VOICE_MODEL_PATH: Path = Field(
        default=MODELS_DIR / "voice_model.h5",
        description="Voice recognition model path"
    )

    WHISPER_MODEL_SIZE: str = Field(
        default="base",
        pattern="^(tiny|base|small|medium|large)$",
        description="Whisper model size (tiny|base|small|medium|large)"
    )

    WHISPER_CACHE_DIR: Path = Field(
        default=ASSETS_DIR / "whisper_cache",
        description="Whisper cache directory"
    )

    # ==================== Scenario Configuration ====================
    SCENARIO_PATH: Path = Field(
        default=SCENARIOS_DIR,
        description="Scenarios directory"
    )

    # ==================== Ollama LLM Configuration ====================
    OLLAMA_HOST: str = Field(
        default="http://localhost:11434",
        description="Ollama host address"
    )

    OLLAMA_MODEL: str = Field(
        default="llama3",
        description="Ollama model to use"
    )

    OLLAMA_TIMEOUT: int = Field(
        default=30,
        ge=5,
        description="Ollama timeout (in seconds)"
    )

    # ==================== Performance Configuration ====================
    MAX_CONCURRENT_USERS: int = Field(
        default=4,
        ge=1,
        le=500,
        description="Maximum number of concurrent users"
    )

    WHISPER_WORKER_THREADS: int = Field(
        default=4,
        ge=1,
        le=16,
        description="Number of background threads for Whisper transcription"
    )

    # ==================== Security Configuration ====================
    JWT_SECRET: str = Field(
        default="change-me-in-production",
        min_length=32,
        description="JWT secret key"
    )

    CORS_ORIGINS: str = Field(
        default="http://localhost:3000",
        description="Comma-separated list of allowed CORS origins"
    )

    # ==================== Logging Configuration ====================
    LOG_LEVEL: str = Field(
        default="INFO",
        pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$",
        description="Logging level"
    )

    LOG_FILE: Path = Field(
        default=LOGGING_DIR / "training.log",
        description="Logging file"
    )

    # ==================== Feature Flags ====================
    ENABLE_TRANSCRIPTION: bool = Field(
        default=True,
        description="Enable transcription (Whisper)"
    )

    ENABLE_OLLAMA: bool = Field(
        default=True,
        description="Enable Ollama LLM feedback"
    )

    # Pydantic v2 configuration
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore"
    )

    @field_validator("JWT_SECRET")
    @classmethod
    def validate_jwt_secret(cls, v: str) -> str:
        """Warn if using default JWT secret."""
        if v == "change-me-in-production":
            import warnings
            warnings.warn(
                "Using default JWT_SECRET! Change this in production!",
                UserWarning
            )
        return v

    def validate_model_paths(self) -> None:
        """
        Validate that all model file exist.
        Call this after loading settings.
        """
        models = {
            "Emotion model": self.EMOTION_MODEL_PATH,
            "Gesture model": self.GESTURE_MODEL_PATH,
            "Voice model": self.VOICE_MODEL_PATH,
        }

        missing_models = []
        for name, path in models.items():
            if not path.exists():
                missing_models.append(f"{name}: {path}")

        if missing_models:
            raise FileNotFoundError(
                f"Missing model files: \n" + "\n".join(missing_models) |
                f"\n\nRun 'make models' or 'python scripts/download_models.py' to download the models"
            )

    def create_directories(self) -> None:
        """Create necessary directories if they don't exist."""
        dirs = [
            self.WHISPER_CACHE_DIR,
            self.SCENARIO_PATH,
            Path(self.LOG_FILE).parent,
        ]

        for directories in dirs:
            directories.mkdir(parents=True, exist_ok=True)

settings = Settings()