"""Domain exceptions.

Every exception carries a stable, machine-readable ``code`` and a message that is safe to
return to API clients. Messages must never contain transcript text or credentials.
"""

from __future__ import annotations


class DomainError(Exception):
    """Base class for errors that can be shown to API clients."""

    status_code: int = 400
    code: str = "bad_request"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code


class UnauthorizedError(DomainError):
    status_code = 401
    code = "unauthorized"


class NotFoundError(DomainError):
    status_code = 404
    code = "not_found"


class ConflictError(DomainError):
    status_code = 409
    code = "conflict"


class ValidationFailedError(DomainError):
    status_code = 422
    code = "validation_error"


class PayloadTooLargeError(DomainError):
    status_code = 413
    code = "payload_too_large"


class InternalError(DomainError):
    status_code = 500
    code = "internal_error"
