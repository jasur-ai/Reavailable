"""Core business logic: job lifecycle, speech synthesis, delete-after-acknowledgement and retention.

Job lifecycle::

    queued --(worker claims job)--> processing --(every chunk synthesized)--> ready
    processing --(permanent or exhausted failure)--> failed --(retry)--> queued
    ready --(device acknowledges every chunk, or DELETE)--> removed

Chunk lifecycle: pending -> ready -> acked. Failed chunks return to pending on retry.

Transcript text is kept only until a chunk is acknowledged. Whole jobs are deleted when they
are fully acknowledged, deleted by the owner, or past their TTL.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
import uuid
from collections import Counter
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, cast

from sqlalchemy import delete, select, update
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session, selectinload, sessionmaker

from app.chunking import build_chunks, has_cyrillic
from app.config import Settings
from app.errors import (
    ConflictError,
    InternalError,
    NotFoundError,
    PayloadTooLargeError,
    ValidationFailedError,
)
from app.models import Chunk, ChunkStatus, Job, JobStatus
from app.security import hash_token, new_access_token, token_matches
from app.storage import BlobStore
from app.timeutil import utc_now
from app.tts.base import SynthesisResult, TransientTTSError, TTSError, TTSProvider

logger = logging.getLogger("audiobook.service")

MAX_TITLE_CHARS = 200
MAX_ERROR_MESSAGE_CHARS = 300

ERROR_MESSAGES: dict[str, str] = {
    "tts_auth_failed": "The speech provider rejected the service credentials. Contact the operator.",
    "tts_bad_request": "The speech provider rejected part of the text. Fix the transcript and retry.",
    "tts_unavailable": "The speech provider is temporarily unavailable. Retry later.",
    "internal_error": "An unexpected error stopped synthesis. Retry later.",
}


@dataclass(frozen=True, slots=True)
class JobView:
    id: str
    title: str
    voice: str
    status: str
    error_code: str | None
    error_message: str | None
    warnings: tuple[str, ...]
    total_chunks: int
    ready_chunks: int
    acked_chunks: int
    failed_chunks: int
    created_at: datetime
    expires_at: datetime


@dataclass(frozen=True, slots=True)
class ManifestEntry:
    index: int
    char_count: int
    content_type: str
    size_bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class ManifestView:
    title: str
    total_chunks: int
    entries: tuple[ManifestEntry, ...]


@dataclass(frozen=True, slots=True)
class AckOutcome:
    acknowledged: tuple[int, ...]
    remaining: int
    job_deleted: bool


class ChunkSynthesisError(Exception):
    """Raised by a synthesis worker when a chunk cannot be produced."""

    def __init__(self, code: str, attempts: int) -> None:
        super().__init__(code)
        self.code = code
        self.attempts = attempts


class JobService:
    """Owns every rule about jobs. Routes stay thin and delegate here."""

    def __init__(
        self,
        *,
        settings: Settings,
        session_factory: sessionmaker[Session],
        blobs: BlobStore,
        provider: TTSProvider,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._settings = settings
        self._session_factory = session_factory
        self._blobs = blobs
        self._provider = provider
        self._sleep = sleep
        self._closing = threading.Event()

    # ------------------------------------------------------------------ creation

    def create_job(
        self,
        *,
        title: str,
        transcript: str,
        sentences_per_chunk: int,
        voice: str | None,
    ) -> tuple[JobView, str]:
        """Validate and store a new transcript. Returns the job view and its one-time access token."""
        clean_title = " ".join(title.split())[:MAX_TITLE_CHARS]
        if not clean_title:
            raise ValidationFailedError("Title must not be blank.", code="invalid_title")
        if len(transcript) > self._settings.max_transcript_chars:
            raise PayloadTooLargeError(
                f"Transcript exceeds the limit of {self._settings.max_transcript_chars} characters.",
                code="transcript_too_long",
            )
        chosen_voice = voice or self._provider.allowed_voices[0]
        if chosen_voice not in self._provider.allowed_voices:
            raise ValidationFailedError("The requested voice is not available.", code="unsupported_voice")

        segments = build_chunks(
            transcript,
            sentences_per_chunk=sentences_per_chunk,
            max_chunk_chars=self._settings.max_chunk_chars,
        )
        if not segments:
            raise ValidationFailedError("The transcript contains no readable text.", code="empty_transcript")
        if len(segments) > self._settings.max_chunks_per_job:
            raise ValidationFailedError(
                f"The transcript would produce {len(segments)} chunks; the limit is "
                f"{self._settings.max_chunks_per_job}.",
                code="too_many_chunks",
            )

        notes = ["cyrillic_text"] if has_cyrillic(transcript) else []
        token = new_access_token()
        now = utc_now()
        job = Job(
            id=str(uuid.uuid4()),
            token_hash=hash_token(token),
            title=clean_title,
            voice=chosen_voice,
            sentences_per_chunk=sentences_per_chunk,
            status=JobStatus.QUEUED,
            warnings=json.dumps(notes),
            created_at=now,
            updated_at=now,
            expires_at=now + timedelta(hours=self._settings.job_ttl_hours),
        )
        job.chunks = [
            Chunk(position=position, status=ChunkStatus.PENDING, text=text, char_count=len(text), attempts=0)
            for position, text in enumerate(segments)
        ]
        with self._session_factory() as session:
            session.add(job)
            session.commit()
            view = self._view(job)
        logger.info("job created id=%s chunks=%d voice=%s", job.id, len(segments), chosen_voice)
        return view, token

    # ------------------------------------------------------------------ queries

    def get_job(self, job_id: str, token: str) -> JobView:
        with self._session_factory() as session:
            return self._view(self._authorize(session, job_id, token))

    def get_manifest(self, job_id: str, token: str) -> ManifestView:
        """List chunks that are ready for download and not yet acknowledged."""
        with self._session_factory() as session:
            job = self._authorize(session, job_id, token)
            if job.status != JobStatus.READY:
                raise ConflictError("The job is not ready yet.", code="job_not_ready")
            entries = tuple(self._entry(chunk) for chunk in job.chunks if chunk.status == ChunkStatus.READY)
            return ManifestView(title=job.title, total_chunks=len(job.chunks), entries=entries)

    def read_chunk(self, job_id: str, token: str, position: int) -> tuple[bytes, ManifestEntry]:
        with self._session_factory() as session:
            job = self._authorize(session, job_id, token)
            if job.status != JobStatus.READY:
                raise ConflictError("The job is not ready yet.", code="job_not_ready")
            chunk = _find_chunk(job, position)
            if chunk.status != ChunkStatus.READY or chunk.audio_path is None:
                raise NotFoundError("The chunk is not available for download.", code="chunk_unavailable")
            entry = self._entry(chunk)
            relative = chunk.audio_path

        try:
            data = self._blobs.read(relative)
        except FileNotFoundError as exc:
            logger.error("audio file missing job=%s position=%d", job_id, position)
            raise NotFoundError("The chunk is not available for download.", code="chunk_unavailable") from exc
        if hashlib.sha256(data).hexdigest() != entry.sha256:
            logger.error("stored audio failed checksum job=%s position=%d", job_id, position)
            raise InternalError("Stored audio is corrupted.", code="chunk_corrupted")
        return data, entry

    # ------------------------------------------------------------------ mutations

    def acknowledge(self, job_id: str, token: str, items: Sequence[tuple[int, str]]) -> AckOutcome:
        """Delete audio for chunks the device has stored and verified.

        Every item is validated before anything changes, so a bad checksum never deletes partial
        data. Repeating an acknowledgement with the same checksum is harmless.
        """
        with self._session_factory() as session:
            job = self._authorize(session, job_id, token)
            if job.status != JobStatus.READY:
                raise ConflictError("The job is not ready for acknowledgement.", code="job_not_ready")

            to_release: dict[int, Chunk] = {}
            for position, digest in items:
                chunk = _find_chunk(job, position)
                if chunk.status not in (ChunkStatus.READY, ChunkStatus.ACKED):
                    raise ConflictError(f"Chunk {position} is not ready.", code="chunk_not_ready")
                if not _digest_matches(chunk.sha256, digest):
                    raise ConflictError(f"Checksum mismatch for chunk {position}.", code="checksum_mismatch")
                if chunk.status == ChunkStatus.READY:
                    to_release[chunk.id] = chunk

            paths: list[str] = []
            for chunk in to_release.values():
                if chunk.audio_path:
                    paths.append(chunk.audio_path)
                chunk.status = ChunkStatus.ACKED
                chunk.audio_path = None
                chunk.text = None

            remaining = sum(1 for chunk in job.chunks if chunk.status != ChunkStatus.ACKED)
            job_deleted = remaining == 0
            if job_deleted:
                session.delete(job)
            session.commit()
            acknowledged = tuple(sorted({position for position, _ in items}))

        for relative in paths:
            self._blobs.delete(relative)
        if job_deleted:
            self._blobs.delete_job(job_id)
            logger.info("job fully acknowledged and removed id=%s", job_id)
        return AckOutcome(acknowledged=acknowledged, remaining=remaining, job_deleted=job_deleted)

    def retry_job(self, job_id: str, token: str) -> JobView:
        """Re-queue a failed job. Only chunks that failed are synthesized again."""
        with self._session_factory() as session:
            job = self._authorize(session, job_id, token)
            if job.status != JobStatus.FAILED:
                raise ConflictError("Only failed jobs can be retried.", code="job_not_failed")
            for chunk in job.chunks:
                if chunk.status == ChunkStatus.FAILED:
                    chunk.status = ChunkStatus.PENDING
                    chunk.attempts = 0
                    chunk.last_error = None
            job.status = JobStatus.QUEUED
            job.error_code = None
            job.error_message = None
            job.updated_at = utc_now()
            session.commit()
            return self._view(job)

    def delete_job(self, job_id: str, token: str) -> None:
        with self._session_factory() as session:
            job = self._authorize(session, job_id, token)
            session.delete(job)
            session.commit()
        self._blobs.delete_job(job_id)
        logger.info("job deleted by owner id=%s", job_id)

    # ------------------------------------------------------------------ background work

    def process_job(self, job_id: str) -> None:
        """Synthesize all pending chunks of a queued job. Safe to call again; it never raises."""
        try:
            self._process(job_id)
        except Exception:
            logger.exception("job processing crashed id=%s", job_id)
            self._set_job_status(
                job_id, JobStatus.FAILED, error=("internal_error", ERROR_MESSAGES["internal_error"])
            )

    def recover_interrupted(self) -> list[str]:
        """Re-queue jobs left mid-flight by a restart and return the queued job identifiers."""
        with self._session_factory() as session:
            session.execute(
                update(Job)
                .where(Job.status == JobStatus.PROCESSING)
                .values(status=JobStatus.QUEUED, updated_at=utc_now())
            )
            ids = list(
                session.scalars(select(Job.id).where(Job.status == JobStatus.QUEUED).order_by(Job.created_at))
            )
            session.commit()
        if ids:
            logger.warning("re-queued %d job(s) interrupted by a restart", len(ids))
        return ids

    def purge_expired(self) -> int:
        """Delete jobs past their TTL and any audio directories without a matching job."""
        now = utc_now()
        with self._session_factory() as session:
            expired = list(session.scalars(select(Job.id).where(Job.expires_at <= now)))
            if expired:
                session.execute(delete(Chunk).where(Chunk.job_id.in_(expired)))
                session.execute(delete(Job).where(Job.id.in_(expired)))
                session.commit()
        for job_id in expired:
            self._blobs.delete_job(job_id)

        # List directories before reading live jobs: a directory can only appear after its job row
        # exists, so any directory listed here is guaranteed to be in the live set read afterwards.
        on_disk = self._blobs.list_job_ids()
        with self._session_factory() as session:
            live = set(session.scalars(select(Job.id)))
        orphans = on_disk - live
        for job_id in orphans:
            self._blobs.delete_job(job_id)
        if expired or orphans:
            logger.info("retention sweep removed expired=%d orphaned=%d", len(expired), len(orphans))
        return len(expired)

    def close(self) -> None:
        """Ask in-flight work to stop after the current segment. Unfinished jobs resume on restart."""
        self._closing.set()

    # ------------------------------------------------------------------ internals

    def _process(self, job_id: str) -> None:
        with self._session_factory() as session:
            claim = cast(
                "CursorResult[Any]",
                session.execute(
                    update(Job)
                    .where(Job.id == job_id, Job.status == JobStatus.QUEUED)
                    .values(
                        status=JobStatus.PROCESSING, error_code=None, error_message=None, updated_at=utc_now()
                    )
                ),
            )
            session.commit()
            if claim.rowcount != 1:
                return
            voice = session.execute(select(Job.voice).where(Job.id == job_id)).scalar_one()
            pending = [
                (chunk.id, chunk.position, chunk.text or "")
                for chunk in session.scalars(
                    select(Chunk)
                    .where(Chunk.job_id == job_id, Chunk.status == ChunkStatus.PENDING)
                    .order_by(Chunk.position)
                )
            ]
        logger.info("processing job id=%s pending_chunks=%d", job_id, len(pending))
        if not pending:
            self._set_job_status(job_id, JobStatus.READY)
            return

        stop = threading.Event()
        failure: tuple[str, str] | None = None
        skipped = False
        with ThreadPoolExecutor(
            max_workers=min(self._settings.tts_concurrency, len(pending)), thread_name_prefix="tts"
        ) as pool:
            futures = {
                pool.submit(self._synthesize_guarded, text, voice, stop): (chunk_id, position)
                for chunk_id, position, text in pending
            }
            for future in as_completed(futures):
                chunk_id, position = futures[future]
                try:
                    outcome = future.result()
                except ChunkSynthesisError as exc:
                    self._record_chunk_failed(chunk_id, exc.attempts, exc.code)
                    failure = failure or (
                        exc.code,
                        ERROR_MESSAGES.get(exc.code, ERROR_MESSAGES["internal_error"]),
                    )
                    logger.error("chunk failed job=%s position=%d code=%s", job_id, position, exc.code)
                    stop.set()
                    continue
                except Exception:
                    logger.exception("unexpected synthesis error job=%s position=%d", job_id, position)
                    self._record_chunk_failed(chunk_id, 1, "internal_error")
                    failure = failure or ("internal_error", ERROR_MESSAGES["internal_error"])
                    stop.set()
                    continue
                if outcome is None:
                    skipped = True
                    continue
                result, attempts = outcome
                self._store_audio(job_id, chunk_id, position, result, attempts)

        if failure is not None:
            self._set_job_status(job_id, JobStatus.FAILED, error=failure)
        elif skipped:  # only happens when the service is closing; resume after restart
            self._set_job_status(job_id, JobStatus.QUEUED)
        else:
            self._set_job_status(job_id, JobStatus.READY)
            logger.info("job ready id=%s", job_id)

    def _synthesize_guarded(
        self, text: str, voice: str, stop: threading.Event
    ) -> tuple[SynthesisResult, int] | None:
        """Run one synthesis task. Any failure raises the flag first so queued tasks stop at once."""
        try:
            return self._synthesize_with_retry(text, voice, stop)
        except BaseException:
            stop.set()
            raise

    def _synthesize_with_retry(
        self, text: str, voice: str, stop: threading.Event
    ) -> tuple[SynthesisResult, int] | None:
        attempts = 0
        while True:
            if stop.is_set() or self._closing.is_set():
                return None
            attempts += 1
            try:
                result = self._provider.synthesize(text, voice)
                if not result.audio:
                    raise TransientTTSError("Speech provider returned empty audio.")
                return result, attempts
            except TransientTTSError as exc:
                logger.warning("transient synthesis failure attempt=%d code=%s", attempts, exc.code)
                if attempts >= self._settings.tts_max_attempts:
                    raise ChunkSynthesisError(exc.code, attempts) from exc
                self._sleep(self._settings.tts_retry_base_delay * (2 ** (attempts - 1)))
            except TTSError as exc:
                logger.warning("permanent synthesis failure attempt=%d code=%s", attempts, exc.code)
                raise ChunkSynthesisError(exc.code, attempts) from exc

    def _store_audio(
        self, job_id: str, chunk_id: int, position: int, result: SynthesisResult, attempts: int
    ) -> None:
        digest = hashlib.sha256(result.audio).hexdigest()
        relative = self._blobs.write(job_id, position, result.extension, result.audio)
        with self._session_factory() as session:
            chunk = session.get(Chunk, chunk_id)
            if chunk is None:  # the job was deleted while this chunk was being synthesized
                self._blobs.delete_job(job_id)
                return
            chunk.status = ChunkStatus.READY
            chunk.audio_path = relative
            chunk.content_type = result.content_type
            chunk.size_bytes = len(result.audio)
            chunk.sha256 = digest
            chunk.attempts = attempts
            chunk.last_error = None
            # The text is needed only to synthesize this part. Failed parts keep it for a retry.
            chunk.text = None
            session.commit()

    def _record_chunk_failed(self, chunk_id: int, attempts: int, code: str) -> None:
        with self._session_factory() as session:
            session.execute(
                update(Chunk)
                .where(Chunk.id == chunk_id)
                .values(status=ChunkStatus.FAILED, attempts=attempts, last_error=code[:50])
            )
            session.commit()

    def _set_job_status(
        self, job_id: str, status: JobStatus, *, error: tuple[str, str] | None = None
    ) -> None:
        values: dict[str, Any] = {"status": status, "updated_at": utc_now()}
        if error is not None:
            values["error_code"] = error[0]
            values["error_message"] = error[1][:MAX_ERROR_MESSAGE_CHARS]
        else:
            values["error_code"] = None
            values["error_message"] = None
        with self._session_factory() as session:
            session.execute(update(Job).where(Job.id == job_id).values(**values))
            session.commit()

    def _authorize(self, session: Session, job_id: str, token: str) -> Job:
        """Load a job the caller may access. Unknown, expired and foreign jobs all look identical."""
        job = session.scalar(select(Job).where(Job.id == job_id).options(selectinload(Job.chunks)))
        if job is None or job.expires_at <= utc_now() or not token_matches(job.token_hash, token):
            raise NotFoundError("Job not found.", code="job_not_found")
        return job

    @staticmethod
    def _entry(chunk: Chunk) -> ManifestEntry:
        return ManifestEntry(
            index=chunk.position,
            char_count=chunk.char_count,
            content_type=chunk.content_type or "application/octet-stream",
            size_bytes=chunk.size_bytes or 0,
            sha256=chunk.sha256 or "",
        )

    @staticmethod
    def _view(job: Job) -> JobView:
        counts = Counter(chunk.status for chunk in job.chunks)
        return JobView(
            id=job.id,
            title=job.title,
            voice=job.voice,
            status=str(job.status),
            error_code=job.error_code,
            error_message=job.error_message,
            warnings=tuple(json.loads(job.warnings)),
            total_chunks=len(job.chunks),
            ready_chunks=counts[ChunkStatus.READY],
            acked_chunks=counts[ChunkStatus.ACKED],
            failed_chunks=counts[ChunkStatus.FAILED],
            created_at=job.created_at,
            expires_at=job.expires_at,
        )


def _find_chunk(job: Job, position: int) -> Chunk:
    for chunk in job.chunks:
        if chunk.position == position:
            return chunk
    raise NotFoundError("Chunk not found.", code="chunk_not_found")


def _digest_matches(stored: str | None, presented: str) -> bool:
    if stored is None:
        return False
    return hmac.compare_digest(stored.encode("utf-8"), presented.encode("utf-8"))
