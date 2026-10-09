"""Shared fixtures: isolated settings, an in-process application and a controllable provider."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.helpers import ControlledProvider


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        environment="test",
        data_dir=tmp_path / "data",
        tts_provider="fake",
        tts_retry_base_delay=0.0,
        tts_concurrency=1,  # deterministic ordering for scripted failures
        tts_max_attempts=3,
        max_chunk_chars=600,
        job_ttl_hours=24,
        purge_interval_seconds=60,
    )


@pytest.fixture
def provider() -> ControlledProvider:
    return ControlledProvider()


@pytest.fixture
def app(settings: Settings, provider: ControlledProvider) -> FastAPI:
    return create_app(
        settings,
        provider=provider,
        inline_worker=True,
        background_tasks=False,
        sleep=lambda _seconds: None,
    )


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client
