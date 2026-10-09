"""Speech synthesis providers and their factory."""

from __future__ import annotations

from app.config import Settings
from app.tts.azure import AzureSpeechProvider
from app.tts.base import (
    PermanentTTSError,
    SynthesisResult,
    TransientTTSError,
    TTSAuthError,
    TTSError,
    TTSProvider,
)
from app.tts.fake import FakeTTSProvider

__all__ = [
    "AzureSpeechProvider",
    "FakeTTSProvider",
    "PermanentTTSError",
    "SynthesisResult",
    "TTSAuthError",
    "TTSError",
    "TTSProvider",
    "TransientTTSError",
    "create_provider",
]


def create_provider(settings: Settings) -> TTSProvider:
    """Build the provider selected by ``AUDIOBOOK_TTS_PROVIDER``."""
    if settings.tts_provider == "azure":
        if settings.azure_speech_key is None or not settings.azure_speech_region:
            raise RuntimeError("Azure speech credentials are not configured")
        return AzureSpeechProvider(
            api_key=settings.azure_speech_key.get_secret_value(),
            region=settings.azure_speech_region,
            output_format=settings.azure_output_format,
            allowed_voices=tuple(settings.allowed_voices),
            timeout_seconds=settings.tts_timeout_seconds,
        )
    return FakeTTSProvider()
