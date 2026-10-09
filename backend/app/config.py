"""Runtime configuration read from environment variables prefixed with ``AUDIOBOOK_``.

See ``backend/.env.example`` for a documented template.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

DEFAULT_UZBEK_VOICES: tuple[str, ...] = ("uz-UZ-MadinaNeural", "uz-UZ-SardorNeural")

AzureOutputFormat = Literal[
    "audio-24khz-48kbitrate-mono-mp3",
    "audio-16khz-32kbitrate-mono-mp3",
    "ogg-24khz-16bit-mono-opus",
    "riff-24khz-16bit-mono-pcm",
]


class Settings(BaseSettings):
    """All tunable parameters of the service."""

    model_config = SettingsConfigDict(env_prefix="AUDIOBOOK_", env_file=".env", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    data_dir: Path = Path("data")
    database_url: str | None = None

    # Protects job creation. Required when environment is "production".
    api_key: SecretStr | None = None

    tts_provider: Literal["azure", "fake"] = "fake"
    azure_speech_key: SecretStr | None = None
    azure_speech_region: str | None = Field(default=None, pattern=r"^[a-z0-9]+$")
    azure_output_format: AzureOutputFormat = "audio-24khz-48kbitrate-mono-mp3"
    allowed_voices: list[str] = Field(default_factory=lambda: list(DEFAULT_UZBEK_VOICES))

    max_request_bytes: int = Field(default=2_000_000, ge=1_024)
    max_transcript_chars: int = Field(default=200_000, ge=1)
    max_chunks_per_job: int = Field(default=3_000, ge=1)
    max_chunk_chars: int = Field(default=600, ge=50, le=3_000)
    job_ttl_hours: int = Field(default=24, ge=1, le=24 * 30)

    worker_threads: int = Field(default=2, ge=1, le=32)
    tts_concurrency: int = Field(default=4, ge=1, le=32)
    tts_max_attempts: int = Field(default=3, ge=1, le=10)
    tts_retry_base_delay: float = Field(default=1.0, ge=0)
    tts_timeout_seconds: float = Field(default=30.0, gt=0)
    purge_interval_seconds: int = Field(default=900, ge=10)

    @model_validator(mode="after")
    def _validate_settings(self) -> Settings:
        if self.tts_provider == "azure" and (self.azure_speech_key is None or not self.azure_speech_region):
            raise ValueError(
                "AUDIOBOOK_AZURE_SPEECH_KEY and AUDIOBOOK_AZURE_SPEECH_REGION are required "
                "when AUDIOBOOK_TTS_PROVIDER=azure"
            )
        if not self.allowed_voices:
            raise ValueError("AUDIOBOOK_ALLOWED_VOICES must list at least one voice")
        if self.environment == "production":
            if self.tts_provider == "fake":
                raise ValueError("The fake TTS provider must not be used in production")
            if self.api_key is None:
                raise ValueError("AUDIOBOOK_API_KEY must be set in production")
        return self

    @property
    def blobs_dir(self) -> Path:
        """Directory holding temporary audio chunks, one sub-directory per job."""
        return self.data_dir / "blobs"

    @property
    def resolved_database_url(self) -> str:
        """Database URL, defaulting to a SQLite file inside ``data_dir``."""
        if self.database_url:
            return self.database_url
        return f"sqlite:///{(self.data_dir / 'audiobook.db').resolve().as_posix()}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-wide settings (cached)."""
    return Settings()
