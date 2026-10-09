"""Background execution: a bounded thread pool for synthesis jobs and a periodic retention sweeper."""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from app.services import JobService

logger = logging.getLogger("audiobook.worker")


class JobRunner:
    """Runs job processing on a bounded thread pool, or inline when ``inline`` is True (tests)."""

    def __init__(self, service: JobService, *, max_workers: int, inline: bool = False) -> None:
        self._service = service
        self._executor: ThreadPoolExecutor | None = (
            None if inline else ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="job")
        )

    def submit(self, job_id: str) -> None:
        if self._executor is None:
            self._service.process_job(job_id)
        else:
            self._executor.submit(self._service.process_job, job_id)

    def shutdown(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)


class RetentionSweeper:
    """Deletes expired jobs and orphaned audio at a fixed interval."""

    def __init__(self, service: JobService, interval_seconds: float) -> None:
        self._service = service
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="retention-sweeper", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self._service.purge_expired()
            except Exception:
                logger.exception("retention sweep failed")
