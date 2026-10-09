"""Local filesystem store for synthesized audio chunks.

Layout: ``<root>/<job_id>/<position>.<extension>``. Every path is validated so that values taken
from the database or from requests can never escape the store root.
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import uuid
from pathlib import Path

_JOB_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_EXTENSION_RE = re.compile(r"^[a-z0-9]{2,5}$")


def _checked_job_id(job_id: str) -> str:
    if not _JOB_ID_RE.match(job_id):
        raise ValueError("Invalid job identifier")
    return job_id


class BlobStore:
    """Stores and retrieves audio bytes on the local filesystem."""

    def __init__(self, root: Path) -> None:
        self._root = root.resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    @property
    def root(self) -> Path:
        return self._root

    def write(self, job_id: str, position: int, extension: str, data: bytes) -> str:
        """Atomically store audio and return its path relative to the store root."""
        if position < 0 or not _EXTENSION_RE.match(extension):
            raise ValueError("Invalid blob name")
        relative = Path(_checked_job_id(job_id)) / f"{position:06d}.{extension}"
        target = self._resolve(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
        with temporary.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        return relative.as_posix()

    def read(self, relative: str) -> bytes:
        """Return the bytes stored at ``relative``. Raises FileNotFoundError if missing."""
        return self._resolve(Path(relative)).read_bytes()

    def delete(self, relative: str) -> None:
        """Delete one stored file. Missing files are ignored."""
        with contextlib.suppress(FileNotFoundError):
            self._resolve(Path(relative)).unlink()

    def delete_job(self, job_id: str) -> None:
        """Delete every file belonging to a job."""
        shutil.rmtree(self._root / _checked_job_id(job_id), ignore_errors=True)

    def list_job_ids(self) -> set[str]:
        """Return the job identifiers that currently have a directory on disk."""
        return {
            entry.name for entry in self._root.iterdir() if entry.is_dir() and _JOB_ID_RE.match(entry.name)
        }

    def _resolve(self, relative: Path) -> Path:
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Path escapes the blob store root")
        target = (self._root / relative).resolve()
        if not target.is_relative_to(self._root):
            raise ValueError("Path escapes the blob store root")
        return target
