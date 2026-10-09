"""Tests for the Azure and fake speech providers."""

from __future__ import annotations

import io
import wave
from typing import Any

import httpx
import pytest

from app.tts.azure import AzureSpeechProvider, build_ssml
from app.tts.base import PermanentTTSError, TransientTTSError, TTSAuthError
from app.tts.fake import FakeTTSProvider

UZ_VOICE = "uz-UZ-MadinaNeural"


def make_azure(
    handler: Any, *, output_format: str = "audio-24khz-48kbitrate-mono-mp3"
) -> AzureSpeechProvider:
    return AzureSpeechProvider(
        api_key="secret-key",
        region="eastus",
        output_format=output_format,
        allowed_voices=(UZ_VOICE,),
        transport=httpx.MockTransport(handler),
    )


def test_ssml_escapes_markup_and_strips_invalid_characters() -> None:
    ssml = build_ssml("Salom <b> & \x01 'dunyo'", UZ_VOICE)
    assert "&lt;b&gt;" in ssml
    assert "&amp;" in ssml
    assert "\x01" not in ssml
    assert 'xml:lang="uz-UZ"' in ssml
    assert f'name="{UZ_VOICE}"' in ssml


def test_successful_request_sends_expected_url_headers_and_body() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["headers"] = request.headers
        seen["body"] = request.content
        return httpx.Response(200, content=b"ID3-audio", headers={"Content-Type": "audio/mpeg"})

    result = make_azure(handler).synthesize("Salom dunyo", UZ_VOICE)

    assert result.audio == b"ID3-audio"
    assert result.content_type == "audio/mpeg"
    assert result.extension == "mp3"
    assert seen["url"] == "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1"
    assert seen["headers"]["Ocp-Apim-Subscription-Key"] == "secret-key"
    assert seen["headers"]["X-Microsoft-OutputFormat"] == "audio-24khz-48kbitrate-mono-mp3"
    assert seen["headers"]["Content-Type"] == "application/ssml+xml"
    assert b"Salom dunyo" in seen["body"]


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (401, TTSAuthError),
        (403, TTSAuthError),
        (400, PermanentTTSError),
        (404, PermanentTTSError),
        (429, TransientTTSError),
        (500, TransientTTSError),
        (503, TransientTTSError),
    ],
)
def test_http_status_codes_are_classified(status: int, expected: type[Exception]) -> None:
    provider = make_azure(lambda request: httpx.Response(status, text="nope"))
    with pytest.raises(expected):
        provider.synthesize("Salom", UZ_VOICE)


def test_credentials_never_appear_in_error_messages() -> None:
    provider = make_azure(lambda request: httpx.Response(401, text="bad key secret-key"))
    with pytest.raises(TTSAuthError) as info:
        provider.synthesize("Salom", UZ_VOICE)
    assert "secret-key" not in str(info.value)


@pytest.mark.parametrize(
    "error",
    [httpx.ConnectTimeout("slow"), httpx.ConnectError("refused"), httpx.ReadTimeout("slow")],
)
def test_network_failures_are_transient(error: Exception) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(TransientTTSError):
        make_azure(handler).synthesize("Salom", UZ_VOICE)


def test_empty_audio_body_is_transient() -> None:
    provider = make_azure(lambda request: httpx.Response(200, content=b""))
    with pytest.raises(TransientTTSError, match="empty audio"):
        provider.synthesize("Salom", UZ_VOICE)


def test_voice_outside_allowlist_is_rejected_before_any_request() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call expected")

    with pytest.raises(PermanentTTSError):
        make_azure(handler).synthesize("Salom", "en-US-JennyNeural")


def test_invalid_region_and_output_format_are_rejected() -> None:
    with pytest.raises(ValueError, match="region"):
        AzureSpeechProvider(
            api_key="k",
            region="East US!",
            output_format="audio-24khz-48kbitrate-mono-mp3",
            allowed_voices=(UZ_VOICE,),
        )
    with pytest.raises(ValueError, match="output format"):
        AzureSpeechProvider(api_key="k", region="eastus", output_format="bogus", allowed_voices=(UZ_VOICE,))
    with pytest.raises(ValueError, match="voice"):
        AzureSpeechProvider(
            api_key="k", region="eastus", output_format="audio-24khz-48kbitrate-mono-mp3", allowed_voices=()
        )


def test_wav_output_format_maps_to_wav_content_type() -> None:
    provider = make_azure(
        lambda request: httpx.Response(200, content=b"RIFF"), output_format="riff-24khz-16bit-mono-pcm"
    )
    result = provider.synthesize("Salom", UZ_VOICE)
    assert (result.content_type, result.extension) == ("audio/wav", "wav")
    provider.close()


def test_fake_provider_returns_a_valid_wav_file() -> None:
    result = FakeTTSProvider().synthesize("Salom dunyo", "fake-uz")
    assert result.content_type == "audio/wav"
    with wave.open(io.BytesIO(result.audio)) as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == 16_000
        assert wav.getnframes() / wav.getframerate() >= 0.25


def test_fake_provider_duration_grows_with_text_length() -> None:
    short = FakeTTSProvider().synthesize("Salom", "fake-uz")
    longer = FakeTTSProvider().synthesize("Salom " * 30, "fake-uz")
    assert len(longer.audio) > len(short.audio)


def test_fake_provider_rejects_bad_input() -> None:
    with pytest.raises(PermanentTTSError, match="empty"):
        FakeTTSProvider().synthesize("   ", "fake-uz")
    with pytest.raises(PermanentTTSError, match="not allowed"):
        FakeTTSProvider().synthesize("Salom", "other-voice")
