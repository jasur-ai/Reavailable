"""Azure AI Speech (neural Text-to-Speech) provider over the REST API with SSML.

Uzbek voices: ``uz-UZ-MadinaNeural`` (female) and ``uz-UZ-SardorNeural`` (male).
"""

from __future__ import annotations

import re
from xml.sax.saxutils import escape

import httpx

from app.tts.base import (
    PermanentTTSError,
    SynthesisResult,
    TransientTTSError,
    TTSAuthError,
)

USER_AGENT = "offline-audiobook-reader-backend/0.1"
SSML_LANGUAGE = "uz-UZ"

_FORMATS: dict[str, tuple[str, str]] = {
    "audio-24khz-48kbitrate-mono-mp3": ("audio/mpeg", "mp3"),
    "audio-16khz-32kbitrate-mono-mp3": ("audio/mpeg", "mp3"),
    "ogg-24khz-16bit-mono-opus": ("audio/ogg", "ogg"),
    "riff-24khz-16bit-mono-pcm": ("audio/wav", "wav"),
}

_REGION_RE = re.compile(r"^[a-z0-9]+$")
_INVALID_XML_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")


def build_ssml(text: str, voice: str) -> str:
    """Build an SSML document for one voice. All text and attribute values are XML-escaped."""
    safe_text = _INVALID_XML_CHARS.sub("", text)
    safe_voice = escape(voice, {'"': "&quot;"})
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xml:lang="{SSML_LANGUAGE}">'
        f'<voice name="{safe_voice}">{escape(safe_text)}</voice>'
        "</speak>"
    )


class AzureSpeechProvider:
    """Synthesizes speech with Azure AI Speech."""

    name = "azure"

    def __init__(
        self,
        *,
        api_key: str,
        region: str,
        output_format: str,
        allowed_voices: tuple[str, ...],
        timeout_seconds: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        if not _REGION_RE.match(region):
            raise ValueError("Azure region must be lowercase letters and digits, e.g. 'eastus'")
        if output_format not in _FORMATS:
            raise ValueError(f"Unsupported Azure output format: {output_format}")
        if not allowed_voices:
            raise ValueError("At least one voice is required")
        self.allowed_voices = allowed_voices
        self._content_type, self._extension = _FORMATS[output_format]
        self._endpoint = f"https://{region}.tts.speech.microsoft.com/cognitiveservices/v1"
        self._client = httpx.Client(
            timeout=timeout_seconds,
            transport=transport,
            headers={
                "Ocp-Apim-Subscription-Key": api_key,
                "X-Microsoft-OutputFormat": output_format,
                "Content-Type": "application/ssml+xml",
                "User-Agent": USER_AGENT,
            },
        )

    def synthesize(self, text: str, voice: str) -> SynthesisResult:
        if voice not in self.allowed_voices:
            raise PermanentTTSError("Voice is not allowed.")
        body = build_ssml(text, voice).encode("utf-8")
        try:
            response = self._client.post(self._endpoint, content=body)
        except httpx.TimeoutException as exc:
            raise TransientTTSError("Speech request timed out.") from exc
        except httpx.HTTPError as exc:
            raise TransientTTSError("Speech request could not reach the provider.") from exc

        status = response.status_code
        if status in (401, 403):
            raise TTSAuthError("Speech provider rejected the credentials.")
        if status == 429 or status >= 500:
            raise TransientTTSError(f"Speech provider returned HTTP {status}.")
        if status != 200:
            raise PermanentTTSError(f"Speech provider returned HTTP {status}.")
        if not response.content:
            raise TransientTTSError("Speech provider returned empty audio.")
        return SynthesisResult(
            audio=response.content, content_type=self._content_type, extension=self._extension
        )

    def close(self) -> None:
        self._client.close()
