"""Tests for background synthesis: retries, failure reporting, retry endpoint and crash recovery."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.main import create_app
from app.models import Chunk, ChunkStatus, Job, JobStatus
from app.tts.base import SynthesisResult, TTSAuthError
from tests.helpers import ControlledProvider, auth, create_job


def job_url(job_id: str, suffix: str = "") -> str:
    return f"/api/v1/jobs/{job_id}{suffix}"


def get_status(client: TestClient, job: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = client.get(job_url(job["id"]), headers=auth(job["access_token"])).json()
    return body


def test_transient_failures_are_retried_until_success(
    client: TestClient, provider: ControlledProvider
) -> None:
    provider.transient_failures = 2  # the first segment fails twice, then succeeds
    job = create_job(client)

    status = get_status(client, job)
    assert status["status"] == "ready"
    assert status["ready_chunks"] == job["total_chunks"]
    assert len(provider.calls) == job["total_chunks"] + 2


def test_exhausted_transient_retries_fail_the_job_with_a_clear_code(
    client: TestClient, provider: ControlledProvider
) -> None:
    provider.transient_failures = 1_000
    job = create_job(client)

    status = get_status(client, job)
    assert status["status"] == "failed"
    assert status["error"]["code"] == "tts_unavailable"
    assert "temporarily unavailable" in status["error"]["message"]
    assert status["failed_chunks"] == 1
    assert len(provider.calls) == 3  # tts_max_attempts


def test_permanent_failure_is_not_retried(client: TestClient, provider: ControlledProvider) -> None:
    provider.permanent_marker = "Bahor"
    job = create_job(client)

    status = get_status(client, job)
    assert status["status"] == "failed"
    assert status["error"]["code"] == "tts_bad_request"
    assert status["failed_chunks"] == 1
    assert sum("Bahor" in call for call in provider.calls) == 1


def test_authentication_failures_map_to_a_distinct_code(settings: Settings) -> None:
    class RejectingProvider(ControlledProvider):
        def synthesize(self, text: str, voice: str) -> SynthesisResult:
            raise TTSAuthError("rejected")

    app: FastAPI = create_app(
        settings, provider=RejectingProvider(), inline_worker=True, background_tasks=False
    )
    with TestClient(app) as client:
        job = create_job(client)
        status = get_status(client, job)
    assert status["status"] == "failed"
    assert status["error"]["code"] == "tts_auth_failed"


def test_failed_job_can_be_retried_after_the_cause_is_fixed(
    client: TestClient, provider: ControlledProvider
) -> None:
    provider.permanent_marker = "Bahor"
    job = create_job(client)
    assert get_status(client, job)["status"] == "failed"

    provider.permanent_marker = None
    response = client.post(job_url(job["id"], "/retry"), headers=auth(job["access_token"]))
    assert response.status_code == 202

    status = get_status(client, job)
    assert status["status"] == "ready"
    assert status["error"] is None
    assert status["ready_chunks"] == job["total_chunks"]


def test_only_failed_jobs_can_be_retried(client: TestClient) -> None:
    job = create_job(client)
    response = client.post(job_url(job["id"], "/retry"), headers=auth(job["access_token"]))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "job_not_failed"


def test_unexpected_provider_crash_marks_the_job_failed_not_stuck(
    client: TestClient, provider: ControlledProvider
) -> None:
    provider.crash_marker = "Bahor"
    job = create_job(client)

    status = get_status(client, job)
    assert status["status"] == "failed"
    assert status["error"]["code"] == "internal_error"


def test_jobs_interrupted_by_a_restart_resume_on_startup(
    settings: Settings, provider: ControlledProvider
) -> None:
    first_app = create_app(settings, provider=provider, inline_worker=True, background_tasks=False)
    with TestClient(first_app) as client:
        job = create_job(client)
        engine = first_app.state.container.engine
    # Simulate a crash in the middle of processing: the job is 'processing' with pending chunks.
    with sessionmaker(bind=engine)() as session:
        session.execute(update(Job).where(Job.id == job["id"]).values(status=JobStatus.PROCESSING))
        session.execute(
            update(Chunk)
            .where(Chunk.job_id == job["id"])
            .values(status=ChunkStatus.PENDING, audio_path=None, sha256=None)
        )
        session.commit()

    second_app = create_app(settings, provider=provider, inline_worker=True, background_tasks=False)
    with TestClient(second_app) as client:
        status = get_status(client, job)
    assert status["status"] == "ready"
    assert status["ready_chunks"] == job["total_chunks"]


def test_chunk_results_are_mapped_to_the_right_positions_under_concurrency(settings: Settings) -> None:
    concurrent_settings = settings.model_copy(update={"tts_concurrency": 4})
    provider = ControlledProvider()
    app = create_app(concurrent_settings, provider=provider, inline_worker=True, background_tasks=False)
    transcript = " ".join(f"Gap raqami {number} tugaydi." for number in range(40))
    with TestClient(app) as client:
        job = create_job(client, transcript=transcript, sentences_per_chunk=1)
        manifest = client.get(job_url(job["id"], "/manifest"), headers=auth(job["access_token"])).json()
        for entry in manifest["chunks"]:
            downloaded = client.get(
                job_url(job["id"], f"/chunks/{entry['index']}"), headers=auth(job["access_token"])
            )
            # One sentence per part, so part N holds sentence N.
            expected_tail = f"Gap raqami {entry['index']} tugaydi.".encode()
            assert downloaded.content.endswith(expected_tail), entry["index"]
    assert len(manifest["chunks"]) == 40


def test_manifest_of_a_ready_job_lists_every_part_with_a_checksum(client: TestClient) -> None:
    job = create_job(client)
    manifest = client.get(job_url(job["id"], "/manifest"), headers=auth(job["access_token"])).json()
    assert len(manifest["chunks"]) == job["total_chunks"]
    assert all(len(chunk["sha256"]) == 64 for chunk in manifest["chunks"])


def test_transcript_text_is_dropped_once_a_part_is_synthesized(
    client: TestClient, provider: ControlledProvider
) -> None:
    provider.permanent_marker = "Bahor"  # the first part fails for good; the rest are left pending
    job = create_job(client)
    engine = client.app.state.container.engine  # type: ignore[attr-defined]
    with sessionmaker(bind=engine)() as session:
        chunks = list(session.scalars(select(Chunk).where(Chunk.job_id == job["id"])))
    assert chunks
    for chunk in chunks:
        if chunk.status == ChunkStatus.READY:
            assert chunk.text is None
        else:
            # Parts that are not ready keep their text, so a retry can synthesize them.
            assert chunk.text


def test_database_rows_match_the_api_view(client: TestClient) -> None:
    job = create_job(client)
    engine = client.app.state.container.engine  # type: ignore[attr-defined]
    with sessionmaker(bind=engine)() as session:
        statuses = list(session.scalars(select(Chunk.status).where(Chunk.job_id == job["id"])))
    assert set(statuses) == {ChunkStatus.READY}
    assert len(statuses) == job["total_chunks"]
