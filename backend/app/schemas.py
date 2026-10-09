"""Request and response models of the HTTP API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CreateJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200, description="Book title shown in the app.")
    transcript: str = Field(
        min_length=1,
        max_length=2_000_000,
        description="Plain-text transcript. Total length is limited by server configuration.",
    )
    sentences_per_chunk: Literal[1, 2] = Field(
        default=2, description="How many sentences go into one audio chunk."
    )
    voice: str | None = Field(
        default=None, max_length=100, description="Voice identifier; server default if omitted."
    )


class ErrorInfo(BaseModel):
    code: str
    message: str


class JobCreatedResponse(BaseModel):
    id: str
    status: str
    title: str
    voice: str
    total_chunks: int
    warnings: list[str]
    expires_at: str
    access_token: str = Field(
        description="Shown only once. Send it as 'Authorization: Bearer <token>' on every later request."
    )


class JobStatusResponse(BaseModel):
    id: str
    status: str
    title: str
    voice: str
    total_chunks: int
    ready_chunks: int
    acked_chunks: int
    failed_chunks: int
    error: ErrorInfo | None
    warnings: list[str]
    created_at: str
    expires_at: str


class ManifestChunk(BaseModel):
    """One audio part. The transcript text is never sent to the device, only its size."""

    index: int
    char_count: int
    content_type: str
    size_bytes: int
    sha256: str
    url: str


class ManifestResponse(BaseModel):
    job_id: str
    title: str
    total_chunks: int
    chunks: list[ManifestChunk]


class AckItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$", description="SHA-256 of the bytes the device stored.")


class AckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chunks: list[AckItem] = Field(min_length=1, max_length=500)


class AckResponse(BaseModel):
    acknowledged: list[int]
    remaining: int
    job_deleted: bool


class HealthResponse(BaseModel):
    status: Literal["ok"]
    version: str
