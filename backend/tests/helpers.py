"""Helpers shared by the test modules."""

from __future__ import annotations

import threading
from typing import Any

from fastapi.testclient import TestClient

from app.tts.base import PermanentTTSError, SynthesisResult, TransientTTSError

SAMPLE_TRANSCRIPT = (
    "Bahor keldi. Bog'lar gullab, qushlar sayrashni boshladi. "
    "Ertalab quyosh nurlari derazadan kirib keldi! "
    "Bolalar maktabga shoshilishdi. Onalar ularga nonushta tayyorlashdi. "
    "Kech kirganda hamma uyga qaytdi."
)

CREATE_PATH = "/api/v1/jobs"


class ControlledProvider:
    """A deterministic speech provider whose failures are scripted by the test."""

    name = "controlled"
    allowed_voices: tuple[str, ...] = ("test-voice", "test-voice-2")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.calls: list[str] = []
        self.transient_failures = 0
        self.permanent_marker: str | None = None
        self.crash_marker: str | None = None

    def synthesize(self, text: str, voice: str) -> SynthesisResult:
        with self._lock:
            self.calls.append(text)
            if self.transient_failures > 0:
                self.transient_failures -= 1
                raise TransientTTSError("try again later")
        if self.crash_marker is not None and self.crash_marker in text:
            raise RuntimeError("unexpected provider crash")
        if self.permanent_marker is not None and self.permanent_marker in text:
            raise PermanentTTSError("segment rejected")
        return SynthesisResult(
            audio=f"AUDIO|{voice}|{text}".encode(),
            content_type="audio/wav",
            extension="wav",
        )


def expected_audio(text: str, voice: str = "test-voice") -> bytes:
    """The bytes ControlledProvider produces for a segment."""
    return f"AUDIO|{voice}|{text}".encode()


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def post_job(client: TestClient, **overrides: Any) -> Any:
    """POST a job with sensible defaults. Returns the raw response."""
    payload: dict[str, Any] = {"title": "Test kitob", "transcript": SAMPLE_TRANSCRIPT}
    payload.update(overrides)
    return client.post(CREATE_PATH, json=payload)


def create_job(client: TestClient, **overrides: Any) -> dict[str, Any]:
    """Create a job and assert success. Returns the parsed creation response."""
    response = post_job(client, **overrides)
    assert response.status_code == 202, response.text
    body: dict[str, Any] = response.json()
    return body
