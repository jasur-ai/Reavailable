"""Provider-agnostic speech synthesis contract and error taxonomy.

Providers raise ``TransientTTSError`` for failures that may succeed on retry and
``PermanentTTSError`` for failures that never will. Error messages must not contain credentials
or transcript text.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class TTSError(Exception):
    """Base class for speech synthesis failures."""

    code: str = "tts_unavailable"


class TransientTTSError(TTSError):
    """A failure that may succeed on retry: timeouts, throttling, 5xx responses."""

    code = "tts_unavailable"


class PermanentTTSError(TTSError):
    """A failure that retrying cannot fix: rejected input or configuration."""

    code = "tts_bad_request"


class TTSAuthError(PermanentTTSError):
    """The provider rejected our credentials."""

    code = "tts_auth_failed"


@dataclass(frozen=True, slots=True)
class SynthesisResult:
    """Encoded audio for one text segment."""

    audio: bytes
    content_type: str
    extension: str


class TTSProvider(Protocol):
    """A speech synthesis backend."""

    name: str
    allowed_voices: tuple[str, ...]

    def synthesize(self, text: str, voice: str) -> SynthesisResult:
        """Synthesize one text segment with the given voice."""
        ...
