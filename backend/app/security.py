"""Access-token and API-key helpers.

Job access tokens are random 256-bit values shown to the client once. Only their SHA-256 digest
is stored, so a leaked database does not expose working tokens.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

TOKEN_BYTES = 32


def new_access_token() -> str:
    """Generate a new URL-safe random access token."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_token(token: str) -> str:
    """Return the hex SHA-256 digest used for storage."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(stored_hash: str, presented_token: str) -> bool:
    """Constant-time comparison of a presented token against its stored digest."""
    return hmac.compare_digest(stored_hash.encode("ascii"), hash_token(presented_token).encode("ascii"))


def api_key_matches(expected: str, presented: str | None) -> bool:
    """Constant-time comparison of the operator API key."""
    if presented is None:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), presented.encode("utf-8"))
