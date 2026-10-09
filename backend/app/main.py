"""Application factory: wires settings, storage, providers, workers and routes together.

Run locally with::

    uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import Engine
from starlette.responses import Response

from app import __version__
from app.api import router
from app.config import Settings, get_settings
from app.container import AppContainer
from app.db import create_db_engine, create_session_factory
from app.errors import DomainError
from app.models import Base
from app.services import JobService
from app.storage import BlobStore
from app.tts import create_provider
from app.tts.base import TTSProvider
from app.worker import JobRunner, RetentionSweeper


def create_app(
    settings: Settings | None = None,
    *,
    provider: TTSProvider | None = None,
    inline_worker: bool = False,
    background_tasks: bool = True,
    sleep: Callable[[float], None] | None = None,
) -> FastAPI:
    """Build the FastAPI application.

    The keyword arguments exist mainly for tests: they allow a scripted provider, synchronous
    processing and disabling the background threads.
    """
    settings = settings or get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings.data_dir.mkdir(parents=True, exist_ok=True)

    engine: Engine = create_db_engine(settings.resolved_database_url)
    Base.metadata.create_all(engine)
    tts_provider = provider or create_provider(settings)
    service = JobService(
        settings=settings,
        session_factory=create_session_factory(engine),
        blobs=BlobStore(settings.blobs_dir),
        provider=tts_provider,
        sleep=sleep or time.sleep,
    )
    runner = JobRunner(service, max_workers=settings.worker_threads, inline=inline_worker)
    sweeper = RetentionSweeper(service, settings.purge_interval_seconds) if background_tasks else None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        service.purge_expired()
        for job_id in service.recover_interrupted():
            runner.submit(job_id)
        if sweeper is not None:
            sweeper.start()
        try:
            yield
        finally:
            if sweeper is not None:
                sweeper.stop()
            service.close()
            runner.shutdown()
            close = getattr(tts_provider, "close", None)
            if callable(close):
                close()
            engine.dispose()

    app = FastAPI(
        title="Offline Audiobook Reader API",
        version=__version__,
        description=(
            "Turns Uzbek transcripts into audio chunks that the app downloads once "
            "and then deletes from the server."
        ),
        lifespan=lifespan,
    )
    app.state.container = AppContainer(
        settings=settings,
        engine=engine,
        service=service,
        runner=runner,
        sweeper=sweeper,
    )

    @app.middleware("http")
    async def limit_request_size(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.headers.get("transfer-encoding") is not None:
            # A chunked body has no declared size, so the limit could only be checked after reading it.
            return JSONResponse(
                status_code=411,
                content=_error_body("length_required", "Send the request with a Content-Length header."),
            )
        declared = request.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > settings.max_request_bytes:
            return JSONResponse(
                status_code=413, content=_error_body("payload_too_large", "The request body is too large.")
            )
        return await call_next(request)

    @app.exception_handler(DomainError)
    async def handle_domain_error(_request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=_error_body(exc.code, exc.message))

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        # Only field locations and messages are echoed back, never the submitted values.
        details = [
            {"field": ".".join(str(part) for part in error["loc"]), "message": str(error["msg"])}
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "The request is invalid.",
                    "details": details,
                }
            },
        )

    app.include_router(router, prefix="/api/v1")
    return app


def _error_body(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}
