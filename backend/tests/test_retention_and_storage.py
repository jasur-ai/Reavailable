"""Tests for retention (TTL and orphan cleanup), the blob store and security helpers."""

from __future__ import annotations

import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.models import Job
from app.security import api_key_matches, hash_token, new_access_token, token_matches
from app.storage import BlobStore
from app.timeutil import utc_now
from tests.helpers import auth, create_job


def job_url(job_id: str, suffix: str = "") -> str:
    return f"/api/v1/jobs/{job_id}{suffix}"


def test_expired_jobs_are_invisible_before_the_sweep_runs(client: TestClient) -> None:
    job = create_job(client)
    engine = client.app.state.container.engine  # type: ignore[attr-defined]
    with sessionmaker(bind=engine)() as session:
        session.execute(
            update(Job).where(Job.id == job["id"]).values(expires_at=utc_now() - timedelta(minutes=1))
        )
        session.commit()

    assert client.get(job_url(job["id"]), headers=auth(job["access_token"])).status_code == 404


def test_sweep_deletes_expired_jobs_and_their_audio(client: TestClient, settings: Settings) -> None:
    job = create_job(client)
    engine = client.app.state.container.engine  # type: ignore[attr-defined]
    with sessionmaker(bind=engine)() as session:
        session.execute(
            update(Job).where(Job.id == job["id"]).values(expires_at=utc_now() - timedelta(hours=1))
        )
        session.commit()

    removed = client.app.state.container.service.purge_expired()  # type: ignore[attr-defined]

    assert removed == 1
    assert not (settings.blobs_dir / job["id"]).exists()


def test_sweep_removes_audio_directories_without_a_job(client: TestClient, settings: Settings) -> None:
    orphan = settings.blobs_dir / str(uuid.uuid4())
    orphan.mkdir(parents=True)
    (orphan / "000000.wav").write_bytes(b"leftover")
    unrelated = settings.blobs_dir / "not-a-job"
    unrelated.mkdir()

    client.app.state.container.service.purge_expired()  # type: ignore[attr-defined]

    assert not orphan.exists()
    assert unrelated.exists()  # only directories named like job identifiers are managed


def test_sweep_keeps_live_jobs(client: TestClient, settings: Settings) -> None:
    job = create_job(client)
    client.app.state.container.service.purge_expired()  # type: ignore[attr-defined]
    assert (settings.blobs_dir / job["id"]).is_dir()
    assert client.get(job_url(job["id"]), headers=auth(job["access_token"])).status_code == 200


def test_blob_store_round_trip_and_idempotent_delete(tmp_path: Path) -> None:
    store = BlobStore(tmp_path / "blobs")
    job_id = str(uuid.uuid4())

    relative = store.write(job_id, 3, "mp3", b"abc")

    assert relative == f"{job_id}/000003.mp3"
    assert store.read(relative) == b"abc"
    store.delete(relative)
    store.delete(relative)  # deleting twice is harmless
    with pytest.raises(FileNotFoundError):
        store.read(relative)


def test_blob_store_rejects_paths_outside_its_root(tmp_path: Path) -> None:
    store = BlobStore(tmp_path / "blobs")
    with pytest.raises(ValueError, match="escapes the blob store root"):
        store.read("../../etc/passwd")
    with pytest.raises(ValueError, match="escapes the blob store root"):
        store.read("/etc/passwd")
    with pytest.raises(ValueError, match="Invalid job identifier"):
        store.write("../escape", 0, "mp3", b"")
    with pytest.raises(ValueError, match="Invalid blob name"):
        store.write(str(uuid.uuid4()), -1, "mp3", b"")
    with pytest.raises(ValueError, match="Invalid blob name"):
        store.write(str(uuid.uuid4()), 0, "../../x", b"")


def test_blob_store_lists_and_deletes_job_directories(tmp_path: Path) -> None:
    store = BlobStore(tmp_path / "blobs")
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    store.write(first, 0, "wav", b"1")
    store.write(second, 0, "wav", b"2")
    assert store.list_job_ids() == {first, second}

    store.delete_job(first)
    assert store.list_job_ids() == {second}


def test_tokens_are_random_and_stored_as_digests() -> None:
    token = new_access_token()
    digest = hash_token(token)
    assert len(token) >= 43
    assert token not in digest
    assert token_matches(digest, token)
    assert not token_matches(digest, token + "x")
    assert new_access_token() != token


def test_api_key_comparison() -> None:
    assert api_key_matches("key", "key")
    assert not api_key_matches("key", "other")
    assert not api_key_matches("key", None)
    assert api_key_matches("ключ", "ключ")  # non-ASCII keys must not crash the comparison
