"""Deterministic offline provider for local development and tests.

It renders a quiet tone instead of speech, so the whole pipeline runs without cloud credentials.
Settings refuse to start this provider in production.
"""

from __future__ import annotations

import io
import math
import sys
import wave
from array import array

from app.tts.base import PermanentTTSError, SynthesisResult

SAMPLE_RATE = 16_000
TONE_HZ = 220.0
AMPLITUDE = 2_000
CHARS_PER_SECOND = 15.0
MIN_SECONDS = 0.25
MAX_SECONDS = 60.0


class FakeTTSProvider:
    """Produces a WAV tone whose length follows the text length."""

    name = "fake"
    allowed_voices: tuple[str, ...] = ("fake-uz",)

    def synthesize(self, text: str, voice: str) -> SynthesisResult:
        if voice not in self.allowed_voices:
            raise PermanentTTSError("Voice is not allowed.")
        if not text.strip():
            raise PermanentTTSError("Text is empty.")
        seconds = min(max(len(text) / CHARS_PER_SECOND, MIN_SECONDS), MAX_SECONDS)
        return SynthesisResult(audio=_render_wav(seconds), content_type="audio/wav", extension="wav")


def _render_wav(seconds: float) -> bytes:
    count = int(seconds * SAMPLE_RATE)
    samples = array(
        "h",
        (int(AMPLITUDE * math.sin(2 * math.pi * TONE_HZ * i / SAMPLE_RATE)) for i in range(count)),
    )
    if sys.byteorder == "big":
        samples.byteswap()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples.tobytes())
    return buffer.getvalue()
