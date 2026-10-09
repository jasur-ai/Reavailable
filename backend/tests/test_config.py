"""Configuration validation tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.config import DEFAULT_UZBEK_VOICES, Settings


def test_defaults_are_safe_for_local_development(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path)
    assert settings.tts_provider == "fake"
    assert settings.environment == "development"
    assert settings.allowed_voices == list(DEFAULT_UZBEK_VOICES)
    assert settings.resolved_database_url.startswith("sqlite:///")
    assert settings.blobs_dir == tmp_path / "blobs"


def test_azure_requires_credentials_and_a_valid_region() -> None:
    with pytest.raises(ValidationError, match="AZURE_SPEECH_KEY"):
        Settings(_env_file=None, tts_provider="azure")
    with pytest.raises(ValidationError):
        Settings(_env_file=None, tts_provider="azure", azure_speech_key="k", azure_speech_region="East US")
    valid = Settings(_env_file=None, tts_provider="azure", azure_speech_key="k", azure_speech_region="eastus")
    assert valid.azure_speech_key is not None
    assert valid.azure_speech_key.get_secret_value() == "k"


def test_production_refuses_the_fake_provider_and_requires_an_api_key() -> None:
    with pytest.raises(ValidationError, match="fake TTS provider"):
        Settings(_env_file=None, environment="production", api_key="k")
    with pytest.raises(ValidationError, match="AUDIOBOOK_API_KEY"):
        Settings(
            _env_file=None,
            environment="production",
            tts_provider="azure",
            azure_speech_key="k",
            azure_speech_region="eastus",
        )
    production = Settings(
        _env_file=None,
        environment="production",
        tts_provider="azure",
        azure_speech_key="k",
        azure_speech_region="eastus",
        api_key="operator",
    )
    assert production.api_key is not None


def test_empty_voice_list_is_rejected() -> None:
    with pytest.raises(ValidationError, match="at least one voice"):
        Settings(_env_file=None, allowed_voices=[])


def test_environment_variables_are_read_with_the_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AUDIOBOOK_MAX_CHUNK_CHARS", "300")
    monkeypatch.setenv("AUDIOBOOK_ALLOWED_VOICES", '["voice-a", "voice-b"]')
    settings = Settings(_env_file=None)
    assert settings.max_chunk_chars == 300
    assert settings.allowed_voices == ["voice-a", "voice-b"]


def test_out_of_range_limits_are_rejected() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, max_chunk_chars=5)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, job_ttl_hours=0)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, azure_output_format="bogus-format")  # type: ignore[arg-type]
