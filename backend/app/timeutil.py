"""Time helpers.

All timestamps are stored as naive UTC datetimes because SQLite has no timezone support.
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    """Return the current time as a naive datetime expressed in UTC."""
    return datetime.now(UTC).replace(tzinfo=None)


def to_iso8601(value: datetime) -> str:
    """Serialize a naive UTC datetime as ISO 8601 with a trailing ``Z``."""
    return value.replace(tzinfo=UTC).isoformat().replace("+00:00", "Z")
