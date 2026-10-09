"""HTTP routes: create a transcript job, poll it, download chunks, acknowledge, retry and delete.

Authentication: every job endpoint requires ``Authorization: Bearer <access_token>`` returned when
the job was created. Job creation additionally requires ``X-API-Key`` when the operator set one.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Path, Request, Response

from app import __version__
from app.container import AppContainer
from app.errors import UnauthorizedError
from app.schemas import (
    AckRequest,
    AckResponse,
    CreateJobRequest,
    ErrorInfo,
    HealthResponse,
    JobCreatedResponse,
    JobStatusResponse,
    ManifestChunk,
    ManifestResponse,
)
from app.security import api_key_matches
from app.services import JobView
from app.timeutil import to_iso8601

router = APIRouter()

JobIdPath = Annotated[
    str,
    Path(
        min_length=36,
        max_length=36,
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        description="Job identifier returned when the job was created.",
    ),
]
PositionPath = Annotated[int, Path(ge=0, le=100_000, description="Zero-based chunk position.")]


def get_container(request: Request) -> AppContainer:
    container: AppContainer = request.app.state.container
    return container


def get_bearer_token(authorization: Annotated[str | None, Header()] = None) -> str:
    if authorization is None:
        raise UnauthorizedError("A bearer token is required.")
    scheme, _, value = authorization.partition(" ")
    token = value.strip()
    if scheme.lower() != "bearer" or not token:
        raise UnauthorizedError("A bearer token is required.")
    return token


ContainerDep = Annotated[AppContainer, Depends(get_container)]
TokenDep = Annotated[str, Depends(get_bearer_token)]


@router.get("/health", response_model=HealthResponse, tags=["system"])
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@router.post("/jobs", status_code=202, response_model=JobCreatedResponse, tags=["jobs"])
def create_job(
    body: CreateJobRequest,
    container: ContainerDep,
    x_api_key: Annotated[str | None, Header()] = None,
) -> JobCreatedResponse:
    expected_key = container.settings.api_key
    if expected_key is not None and not api_key_matches(expected_key.get_secret_value(), x_api_key):
        raise UnauthorizedError("A valid API key is required to create jobs.")

    view, token = container.service.create_job(
        title=body.title,
        transcript=body.transcript,
        sentences_per_chunk=body.sentences_per_chunk,
        voice=body.voice,
    )
    container.runner.submit(view.id)
    return JobCreatedResponse(
        id=view.id,
        status=view.status,
        title=view.title,
        voice=view.voice,
        total_chunks=view.total_chunks,
        warnings=list(view.warnings),
        expires_at=to_iso8601(view.expires_at),
        access_token=token,
    )


@router.get("/jobs/{job_id}", response_model=JobStatusResponse, tags=["jobs"])
def get_job(job_id: JobIdPath, token: TokenDep, container: ContainerDep) -> JobStatusResponse:
    return _status_response(container.service.get_job(job_id, token))


@router.get("/jobs/{job_id}/manifest", response_model=ManifestResponse, tags=["jobs"])
def get_manifest(job_id: JobIdPath, token: TokenDep, container: ContainerDep) -> ManifestResponse:
    manifest = container.service.get_manifest(job_id, token)
    return ManifestResponse(
        job_id=job_id,
        title=manifest.title,
        total_chunks=manifest.total_chunks,
        chunks=[
            ManifestChunk(
                index=entry.index,
                char_count=entry.char_count,
                content_type=entry.content_type,
                size_bytes=entry.size_bytes,
                sha256=entry.sha256,
                url=f"/api/v1/jobs/{job_id}/chunks/{entry.index}",
            )
            for entry in manifest.entries
        ],
    )


@router.get(
    "/jobs/{job_id}/chunks/{position}",
    tags=["jobs"],
    responses={200: {"content": {"audio/*": {}}, "description": "Audio bytes for one chunk."}},
)
def get_chunk(
    job_id: JobIdPath, position: PositionPath, token: TokenDep, container: ContainerDep
) -> Response:
    data, entry = container.service.read_chunk(job_id, token, position)
    return Response(
        content=data,
        media_type=entry.content_type,
        headers={"X-Content-SHA256": entry.sha256, "Cache-Control": "no-store"},
    )


@router.post("/jobs/{job_id}/ack", response_model=AckResponse, tags=["jobs"])
def acknowledge(job_id: JobIdPath, body: AckRequest, token: TokenDep, container: ContainerDep) -> AckResponse:
    outcome = container.service.acknowledge(
        job_id, token, [(item.index, item.sha256) for item in body.chunks]
    )
    return AckResponse(
        acknowledged=list(outcome.acknowledged),
        remaining=outcome.remaining,
        job_deleted=outcome.job_deleted,
    )


@router.post("/jobs/{job_id}/retry", status_code=202, response_model=JobStatusResponse, tags=["jobs"])
def retry_job(job_id: JobIdPath, token: TokenDep, container: ContainerDep) -> JobStatusResponse:
    view = container.service.retry_job(job_id, token)
    container.runner.submit(view.id)
    return _status_response(view)


@router.delete("/jobs/{job_id}", status_code=204, tags=["jobs"])
def delete_job(job_id: JobIdPath, token: TokenDep, container: ContainerDep) -> Response:
    container.service.delete_job(job_id, token)
    return Response(status_code=204)


def _status_response(view: JobView) -> JobStatusResponse:
    error = None
    if view.error_code is not None:
        error = ErrorInfo(code=view.error_code, message=view.error_message or "")
    return JobStatusResponse(
        id=view.id,
        status=view.status,
        title=view.title,
        voice=view.voice,
        total_chunks=view.total_chunks,
        ready_chunks=view.ready_chunks,
        acked_chunks=view.acked_chunks,
        failed_chunks=view.failed_chunks,
        error=error,
        warnings=list(view.warnings),
        created_at=to_iso8601(view.created_at),
        expires_at=to_iso8601(view.expires_at),
    )
