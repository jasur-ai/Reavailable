"""Object graph shared by request handlers. Created once per application instance."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.engine import Engine

from app.config import Settings
from app.services import JobService
from app.worker import JobRunner, RetentionSweeper


@dataclass(frozen=True, slots=True)
class AppContainer:
    settings: Settings
    engine: Engine
    service: JobService
    runner: JobRunner
    sweeper: RetentionSweeper | None
