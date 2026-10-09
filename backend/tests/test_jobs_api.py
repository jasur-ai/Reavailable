"""End-to-end tests of the HTTP API: creation, sync, acknowledgement, deletion and access control."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import text

from app.config import Settings
from app.errors import DomainError
from app.main import create_app
from app.security import hash_token
from tests.helpers import (
    CREATE_PATH,
    SAMPLE_TRANSCRIPT,
    ControlledProvider,
    auth,
    create_job,
    expected_audio,
    post_job,
)


def job_url(job_id: str, suffix: str = "") -> str:
    return f"/api/v1/jobs/{job_id}{suffix}"


def fetch_manifest(client: TestClient, job: dict[str, Any]) -> dict[str, Any]:
    response = client.get(job_url(job["id"], "/manifest"), headers=auth(job["access_token"]))
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def ack(client: TestClient, job: dict[str, Any], items: list[tuple[int, str]]) -> Any:
    return client.post(
        job_url(job["id"], "/ack"),
        headers=auth(job["access_token"]),
        json={"chunks": [{"index": index, "sha256": digest} for index, digest in items]},
    )


def test_health_endpoint(client: TestClient) -> None:
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_creating_a_job_synthesizes_every_chunk(client: TestClient) -> None:
    job = create_job(client)

    assert job["status"] == "queued"  # the snapshot returned at creation time
    assert job["total_chunks"] == 3  # six sentences grouped in pairs
    assert len(job["access_token"]) >= 40
    assert job["warnings"] == []

    status = client.get(job_url(job["id"]), headers=auth(job["access_token"])).json()
    assert status["status"] == "ready"
    assert status["ready_chunks"] == job["total_chunks"]
    assert status["failed_chunks"] == 0
    assert status["error"] is None


def test_access_token_is_stored_only_as_a_digest(client: TestClient) -> None:
    job = create_job(client)
    engine = client.app.state.container.engine  # type: ignore[attr-defined]
    with engine.connect() as connection:
        stored = connection.execute(
            text("SELECT token_hash FROM jobs WHERE id = :id"), {"id": job["id"]}
        ).scalar_one()
    assert stored == hash_token(job["access_token"])
    assert job["access_token"] not in stored


def test_manifest_lists_chunks_with_checksums_and_never_the_transcript_text(client: TestClient) -> None:
    job = create_job(client)
    manifest = fetch_manifest(client, job)

    assert manifest["total_chunks"] == job["total_chunks"]
    assert [chunk["index"] for chunk in manifest["chunks"]] == list(range(job["total_chunks"]))
    for chunk in manifest["chunks"]:
        assert len(chunk["sha256"]) == 64
        assert chunk["url"] == job_url(job["id"], f"/chunks/{chunk['index']}")
        assert chunk["char_count"] > 0
        assert set(chunk) == {"index", "char_count", "content_type", "size_bytes", "sha256", "url"}
    assert "Bahor" not in json.dumps(manifest, ensure_ascii=False)


def test_chunk_download_matches_its_checksum_and_text(client: TestClient) -> None:
    job = create_job(client)
    manifest = fetch_manifest(client, job)
    first = manifest["chunks"][0]

    response = client.get(job_url(job["id"], "/chunks/0"), headers=auth(job["access_token"]))

    assert response.status_code == 200
    prefix = b"AUDIO|test-voice|"
    assert response.content.startswith(prefix)
    text = response.content[len(prefix) :].decode("utf-8")
    # The fake provider writes the segment text into the audio, so the bytes reveal the text.
    assert text.startswith("Bahor keldi.")
    assert len(text) == first["char_count"]
    assert response.content == expected_audio(text)
    assert response.headers["X-Content-SHA256"] == hashlib.sha256(response.content).hexdigest()
    assert response.headers["X-Content-SHA256"] == first["sha256"]
    assert response.headers["Cache-Control"] == "no-store"


def test_voice_selection_is_honoured(client: TestClient) -> None:
    job = create_job(client, voice="test-voice-2")
    assert job["voice"] == "test-voice-2"
    response = client.get(job_url(job["id"], "/chunks/0"), headers=auth(job["access_token"]))
    assert response.content.startswith(b"AUDIO|test-voice-2|")


def test_acknowledging_every_chunk_deletes_the_job_and_its_audio(
    client: TestClient, settings: Settings
) -> None:
    job = create_job(client)
    manifest = fetch_manifest(client, job)
    job_dir = settings.blobs_dir / job["id"]
    assert job_dir.is_dir()

    outcome: dict[str, Any] = {}
    for position, chunk in enumerate(manifest["chunks"]):
        response = ack(client, job, [(chunk["index"], chunk["sha256"])])
        assert response.status_code == 200, response.text
        outcome = response.json()
        assert outcome["remaining"] == job["total_chunks"] - position - 1
        assert outcome["job_deleted"] is (position == job["total_chunks"] - 1)

    assert outcome == {"acknowledged": [job["total_chunks"] - 1], "remaining": 0, "job_deleted": True}
    assert not job_dir.exists()
    assert client.get(job_url(job["id"]), headers=auth(job["access_token"])).status_code == 404


def test_partial_acknowledgement_releases_only_selected_chunks(
    client: TestClient, settings: Settings
) -> None:
    job = create_job(client)
    manifest = fetch_manifest(client, job)
    first = manifest["chunks"][0]

    response = ack(client, job, [(0, first["sha256"])])
    body = response.json()
    assert response.status_code == 200
    assert body["remaining"] == job["total_chunks"] - 1
    assert body["job_deleted"] is False

    remaining = fetch_manifest(client, job)
    assert [chunk["index"] for chunk in remaining["chunks"]] == [1, 2]
    gone = client.get(job_url(job["id"], "/chunks/0"), headers=auth(job["access_token"]))
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "chunk_unavailable"


def test_acknowledgement_with_wrong_checksum_is_rejected_and_nothing_is_deleted(client: TestClient) -> None:
    job = create_job(client)
    response = ack(client, job, [(0, "0" * 64)])

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "checksum_mismatch"
    assert len(fetch_manifest(client, job)["chunks"]) == job["total_chunks"]


def test_failed_batch_is_atomic(client: TestClient) -> None:
    job = create_job(client)
    manifest = fetch_manifest(client, job)
    good = manifest["chunks"][0]

    response = ack(client, job, [(0, good["sha256"]), (1, "f" * 64)])

    assert response.status_code == 409
    assert len(fetch_manifest(client, job)["chunks"]) == job["total_chunks"]


def test_repeating_an_acknowledgement_is_idempotent(client: TestClient) -> None:
    job = create_job(client)
    first = fetch_manifest(client, job)["chunks"][0]

    assert ack(client, job, [(0, first["sha256"])]).status_code == 200
    again = ack(client, job, [(0, first["sha256"])])

    assert again.status_code == 200
    assert again.json()["remaining"] == job["total_chunks"] - 1


def test_acknowledging_an_unknown_chunk_is_not_found(client: TestClient) -> None:
    job = create_job(client)
    response = ack(client, job, [(999, "a" * 64)])
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "chunk_not_found"


def test_acknowledgement_rejects_malformed_checksums(client: TestClient) -> None:
    job = create_job(client)
    response = client.post(
        job_url(job["id"], "/ack"),
        headers=auth(job["access_token"]),
        json={"chunks": [{"index": 0, "sha256": "not-a-digest"}]},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_missing_bearer_token_is_unauthorized(client: TestClient) -> None:
    job = create_job(client)
    response = client.get(job_url(job["id"]))
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_wrong_token_and_unknown_job_are_indistinguishable(client: TestClient) -> None:
    job = create_job(client)
    wrong_token = client.get(job_url(job["id"]), headers=auth("not-the-token"))
    unknown_job = client.get(job_url(str(uuid.uuid4())), headers=auth(job["access_token"]))

    assert wrong_token.status_code == unknown_job.status_code == 404
    assert wrong_token.json() == unknown_job.json()


def test_one_jobs_token_cannot_access_another_job(client: TestClient) -> None:
    first = create_job(client)
    second = create_job(client)
    response = client.get(job_url(first["id"]), headers=auth(second["access_token"]))
    assert response.status_code == 404


def test_malformed_job_identifier_is_a_validation_error(client: TestClient) -> None:
    response = client.get(job_url("not-a-uuid"), headers=auth("token"))
    assert response.status_code == 422


def test_deleting_a_job_removes_its_audio(client: TestClient, settings: Settings) -> None:
    job = create_job(client)
    response = client.delete(job_url(job["id"]), headers=auth(job["access_token"]))

    assert response.status_code == 204
    assert not (settings.blobs_dir / job["id"]).exists()
    assert client.get(job_url(job["id"]), headers=auth(job["access_token"])).status_code == 404


def test_deleting_with_a_wrong_token_changes_nothing(client: TestClient) -> None:
    job = create_job(client)
    assert client.delete(job_url(job["id"]), headers=auth("wrong")).status_code == 404
    assert client.get(job_url(job["id"]), headers=auth(job["access_token"])).status_code == 200


def test_manifest_is_unavailable_until_the_job_is_ready(
    client: TestClient, provider: ControlledProvider
) -> None:
    provider.permanent_marker = "Bahor"
    job = create_job(client)
    response = client.get(job_url(job["id"], "/manifest"), headers=auth(job["access_token"]))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "job_not_ready"


def test_creation_rejects_blank_transcripts(client: TestClient) -> None:
    response = post_job(client, transcript="   \n\t  ")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_service_rejects_transcripts_without_readable_text(client: TestClient) -> None:
    service = client.app.state.container.service  # type: ignore[attr-defined]
    with pytest.raises(DomainError) as info:
        service.create_job(title="Kitob", transcript=" \n ", sentences_per_chunk=2, voice=None)
    assert info.value.code == "empty_transcript"


def test_creation_rejects_invalid_fields(client: TestClient) -> None:
    assert post_job(client, transcript="").status_code == 422
    assert post_job(client, title="   ").status_code == 422
    assert post_job(client, sentences_per_chunk=3).status_code == 422
    assert post_job(client, voice="en-US-JennyNeural").json()["error"]["code"] == "unsupported_voice"
    assert (
        client.post(CREATE_PATH, json={"title": "x", "transcript": "Salom.", "unknown": 1}).status_code == 422
    )


def test_creation_rejects_transcripts_over_the_length_limit(
    settings: Settings, provider: ControlledProvider
) -> None:
    limited = settings.model_copy(update={"max_transcript_chars": 50})
    app = create_app(limited, provider=provider, inline_worker=True, background_tasks=False)
    with TestClient(app) as client:
        response = post_job(client, transcript="Salom dunyo. " * 10)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "transcript_too_long"


def test_creation_rejects_jobs_that_produce_too_many_chunks(
    settings: Settings, provider: ControlledProvider
) -> None:
    limited = settings.model_copy(update={"max_chunks_per_job": 2})
    app = create_app(limited, provider=provider, inline_worker=True, background_tasks=False)
    with TestClient(app) as client:
        response = post_job(client, transcript=SAMPLE_TRANSCRIPT, sentences_per_chunk=1)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "too_many_chunks"


def test_request_bodies_over_the_byte_limit_are_refused(
    settings: Settings, provider: ControlledProvider
) -> None:
    small = settings.model_copy(update={"max_request_bytes": 1_024})
    app = create_app(small, provider=provider, inline_worker=True, background_tasks=False)
    with TestClient(app) as client:
        response = post_job(client, transcript="Salom dunyo. " * 200)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_chunked_request_bodies_are_refused_because_their_size_cannot_be_checked(client: TestClient) -> None:
    def body() -> Iterator[bytes]:
        yield b'{"title": "Kitob", "transcript": "Salom dunyo."}'

    response = client.post(CREATE_PATH, content=body(), headers={"Content-Type": "application/json"})

    assert response.status_code == 411
    assert response.json()["error"]["code"] == "length_required"


def test_operator_api_key_protects_job_creation(settings: Settings, provider: ControlledProvider) -> None:
    keyed = settings.model_copy(update={"api_key": SecretStr("operator-secret")})
    app: FastAPI = create_app(keyed, provider=provider, inline_worker=True, background_tasks=False)
    with TestClient(app) as client:
        assert post_job(client).status_code == 401
        wrong = client.post(
            CREATE_PATH,
            json={"title": "Kitob", "transcript": SAMPLE_TRANSCRIPT},
            headers={"X-API-Key": "wrong"},
        )
        assert wrong.status_code == 401
        ok = client.post(
            CREATE_PATH,
            json={"title": "Kitob", "transcript": SAMPLE_TRANSCRIPT},
            headers={"X-API-Key": "operator-secret"},
        )
        assert ok.status_code == 202


def test_cyrillic_transcripts_carry_a_warning(client: TestClient) -> None:
    job = create_job(client, transcript="Ўзбекистон гўзал юрт. Бу ерда кўп одамлар яшайди.")
    assert job["warnings"] == ["cyrillic_text"]


def test_error_responses_never_echo_the_transcript(client: TestClient) -> None:
    secret_text = "MAXFIY-MATN-123"
    response = client.post(CREATE_PATH, json={"title": "", "transcript": secret_text})
    assert response.status_code == 422
    assert secret_text not in response.text


def test_health_and_docs_are_served(client: TestClient) -> None:
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").json()["info"]["title"] == "Offline Audiobook Reader API"


def test_job_identifiers_are_unguessable_uuids(client: TestClient) -> None:
    job = create_job(client)
    assert str(uuid.UUID(job["id"])) == job["id"]


def test_blobs_directory_is_created_under_data_dir(settings: Settings, client: TestClient) -> None:
    create_job(client)
    assert Path(settings.blobs_dir).is_dir()
