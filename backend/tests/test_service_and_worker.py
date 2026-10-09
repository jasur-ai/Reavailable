"""Service-level and worker tests for paths the HTTP tests reach only indirectly."""

from __future__ import annotations

import hashlib
import time
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, update
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.db import create_db_engine, create_session_factory
from app.errors import ConflictError, DomainError, NotFoundError, ValidationFailedError
from app.main import create_app
from app.models import Base, Chunk, ChunkStatus
from app.services import JobService
from app.storage import BlobStore
from app.tts import create_provider
from app.tts.azure import AzureSpeechProvider
from app.tts.fake import FakeTTSProvider
from app.worker import JobRunner, RetentionSweeper
from tests.helpers import SAMPLE_TRANSCRIPT, ControlledProvider, auth, create_job


@pytest.fixture
def service_and_engine(
    settings: Settings, provider: ControlledProvider
) -> Iterator[tuple[JobService, Engine]]:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    engine = create_db_engine(settings.resolved_database_url)
    Base.metadata.create_all(engine)
    service = JobService(
        settings=settings,
        session_factory=create_session_factory(engine),
        blobs=BlobStore(settings.blobs_dir),
        provider=provider,
        sleep=lambda _seconds: None,
    )
    yield service, engine
    engine.dispose()


def test_service_creates_processes_and_serves_chunks(service_and_engine: tuple[JobService, Engine]) -> None:
    service, _ = service_and_engine
    view, token = service.create_job(
        title="  Kitob   nomi  ", transcript=SAMPLE_TRANSCRIPT, sentences_per_chunk=2, voice=None
    )
    assert view.title == "Kitob nomi"
    assert view.status == "queued"

    service.process_job(view.id)

    done = service.get_job(view.id, token)
    assert done.status == "ready"
    assert done.ready_chunks == view.total_chunks
    manifest = service.get_manifest(view.id, token)
    assert manifest.total_chunks == view.total_chunks
    data, entry = service.read_chunk(view.id, token, 0)
    assert hashlib.sha256(data).hexdigest() == entry.sha256


def test_closing_the_service_leaves_jobs_queued_for_restart(
    service_and_engine: tuple[JobService, Engine],
) -> None:
    service, _ = service_and_engine
    view, token = service.create_job(
        title="Kitob", transcript=SAMPLE_TRANSCRIPT, sentences_per_chunk=2, voice=None
    )
    service.close()

    service.process_job(view.id)

    assert service.get_job(view.id, token).status == "queued"
    assert service.recover_interrupted() == [view.id]


def test_tampered_audio_is_never_served(
    service_and_engine: tuple[JobService, Engine], settings: Settings
) -> None:
    service, _ = service_and_engine
    view, token = service.create_job(
        title="Kitob", transcript=SAMPLE_TRANSCRIPT, sentences_per_chunk=2, voice=None
    )
    service.process_job(view.id)
    (settings.blobs_dir / view.id / "000000.wav").write_bytes(b"tampered")

    with pytest.raises(DomainError) as info:
        service.read_chunk(view.id, token, 0)
    assert info.value.code == "chunk_corrupted"
    assert info.value.status_code == 500


def test_missing_audio_file_reports_chunk_unavailable(
    service_and_engine: tuple[JobService, Engine], settings: Settings
) -> None:
    service, _ = service_and_engine
    view, token = service.create_job(
        title="Kitob", transcript=SAMPLE_TRANSCRIPT, sentences_per_chunk=2, voice=None
    )
    service.process_job(view.id)
    (settings.blobs_dir / view.id / "000000.wav").unlink()

    with pytest.raises(NotFoundError) as info:
        service.read_chunk(view.id, token, 0)
    assert info.value.code == "chunk_unavailable"


def test_acknowledging_a_chunk_that_is_not_ready_is_a_conflict(
    service_and_engine: tuple[JobService, Engine],
) -> None:
    service, engine = service_and_engine
    view, token = service.create_job(
        title="Kitob", transcript=SAMPLE_TRANSCRIPT, sentences_per_chunk=2, voice=None
    )
    service.process_job(view.id)
    with sessionmaker(bind=engine)() as session:
        session.execute(
            update(Chunk)
            .where(Chunk.job_id == view.id, Chunk.position == 1)
            .values(status=ChunkStatus.PENDING, sha256=None, audio_path=None)
        )
        session.commit()

    with pytest.raises(ConflictError) as info:
        service.acknowledge(view.id, token, [(1, "a" * 64)])
    assert info.value.code == "chunk_not_ready"


def test_service_rejects_invalid_creation_parameters(service_and_engine: tuple[JobService, Engine]) -> None:
    service, _ = service_and_engine
    with pytest.raises(ValidationFailedError) as blank_title:
        service.create_job(title="   ", transcript="Salom.", sentences_per_chunk=2, voice=None)
    assert blank_title.value.code == "invalid_title"
    with pytest.raises(ValidationFailedError) as bad_voice:
        service.create_job(title="x", transcript="Salom.", sentences_per_chunk=2, voice="nope")
    assert bad_voice.value.code == "unsupported_voice"


def test_unknown_jobs_raise_not_found(service_and_engine: tuple[JobService, Engine]) -> None:
    service, _ = service_and_engine
    with pytest.raises(NotFoundError):
        service.get_job("00000000-0000-4000-8000-000000000000", "token")


def test_background_worker_processes_jobs_asynchronously(
    settings: Settings, provider: ControlledProvider
) -> None:
    app = create_app(settings, provider=provider, inline_worker=False, background_tasks=True)
    with TestClient(app) as client:
        job = create_job(client)
        status: dict[str, Any] = {}
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            status = client.get(f"/api/v1/jobs/{job['id']}", headers=auth(job["access_token"])).json()
            if status["status"] in ("ready", "failed"):
                break
            time.sleep(0.05)
    assert status["status"] == "ready"


class _RecordingService:
    """Stand-in for JobService that records calls, used to test the worker classes in isolation."""

    def __init__(self, fail_first_purge: bool = False) -> None:
        self.purges = 0
        self.processed: list[str] = []
        self._fail_first_purge = fail_first_purge

    def purge_expired(self) -> int:
        self.purges += 1
        if self._fail_first_purge and self.purges == 1:
            raise RuntimeError("transient database error")
        return 0

    def process_job(self, job_id: str) -> None:
        self.processed.append(job_id)


def test_retention_sweeper_runs_periodically_survives_errors_and_stops() -> None:
    recorder = _RecordingService(fail_first_purge=True)
    sweeper = RetentionSweeper(recorder, interval_seconds=0.01)  # type: ignore[arg-type]
    sweeper.start()
    deadline = time.monotonic() + 10
    while recorder.purges < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    sweeper.stop()

    assert recorder.purges >= 3  # the sweeper keeps going after an error
    stopped_at = recorder.purges
    time.sleep(0.05)
    assert recorder.purges == stopped_at


def test_job_runner_inline_and_threaded_modes() -> None:
    recorder = _RecordingService()
    inline = JobRunner(recorder, max_workers=1, inline=True)  # type: ignore[arg-type]
    inline.submit("inline-job")
    assert recorder.processed == ["inline-job"]
    inline.shutdown()

    threaded = JobRunner(recorder, max_workers=1)  # type: ignore[arg-type]
    threaded.submit("threaded-job")
    threaded.shutdown()
    deadline = time.monotonic() + 10
    while "threaded-job" not in recorder.processed and time.monotonic() < deadline:
        time.sleep(0.01)
    assert "threaded-job" in recorder.processed


def test_provider_factory_builds_the_configured_provider(tmp_path: Any) -> None:
    fake = create_provider(Settings(_env_file=None, data_dir=tmp_path))
    assert isinstance(fake, FakeTTSProvider)

    azure_settings = Settings(
        _env_file=None,
        data_dir=tmp_path,
        tts_provider="azure",
        azure_speech_key="key",
        azure_speech_region="eastus",
    )
    azure = create_provider(azure_settings)
    assert isinstance(azure, AzureSpeechProvider)
    assert azure.allowed_voices == ("uz-UZ-MadinaNeural", "uz-UZ-SardorNeural")
    azure.close()
