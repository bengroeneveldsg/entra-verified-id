"""
FastAPI JWT authentication helpers.

Cookie name : vid_admin_session
Algorithm   : HS256
Expiry      : 8 hours
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, VerificationError, InvalidHashError
from fastapi import Cookie, Depends, HTTPException, Request, status

from app.deps import get_table, secrets_client
from app.settings import settings

logger = logging.getLogger(__name__)

_ph = PasswordHasher(
    time_cost=2,
    memory_cost=65536,
    parallelism=2,
)

_COOKIE_NAME = "vid_admin_session"
_MAX_ATTEMPTS = 5
_LOCK_SECONDS = 15 * 60  # 15 minutes


# ---------------------------------------------------------------------------
# JWT secret (lazily loaded and cached)
# ---------------------------------------------------------------------------
_jwt_secret: str | None = None


def _get_jwt_secret() -> str:
    global _jwt_secret
    if _jwt_secret is not None:
        return _jwt_secret
    resp = secrets_client.get_secret_value(SecretId=settings.jwt_secret_name)
    raw = resp.get("SecretString", "")
    try:
        data = json.loads(raw)
        _jwt_secret = data.get("secret", raw)
    except (json.JSONDecodeError, TypeError):
        _jwt_secret = raw
    return _jwt_secret


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

def create_token(username: str) -> str:
    """Create a signed HS256 JWT with an 8-hour expiry."""
    now = int(time.time())
    payload = {
        "sub": username,
        "username": username,
        "iat": now,
        "exp": now + 8 * 3600,
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm="HS256")


def verify_token(token: str) -> dict[str, Any]:
    """
    Validate signature and expiry.

    Raises :class:`HTTPException` 401 on failure.
    Returns the decoded payload dict.
    """
    try:
        return jwt.decode(
            token,
            _get_jwt_secret(),
            algorithms=["HS256"],
            options={"require": ["sub", "exp", "iat"]},
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session expired",
        )
    except jwt.InvalidTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
        )


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

def current_user(
    request: Request,
    vid_admin_session: str | None = Cookie(default=None),
) -> dict[str, str]:
    """
    FastAPI dependency.  Reads the session cookie, verifies it, then checks
    the AdminUsers table for *disabled* and *locked_until* flags.

    Returns ``{"username": ..., "sub": ...}``.
    """
    if vid_admin_session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    payload = verify_token(vid_admin_session)
    username: str = payload.get("username") or payload.get("sub", "")

    table = get_table(settings.admin_users_table)
    resp = table.get_item(Key={"username": username})
    user = resp.get("Item")

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    if user.get("disabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account disabled",
        )

    locked_until = user.get("locked_until")
    if locked_until:
        if time.time() < float(locked_until):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account temporarily locked due to too many failed attempts",
            )

    return {"username": username, "sub": username}


# ---------------------------------------------------------------------------
# Brute-force helpers
# ---------------------------------------------------------------------------

def record_failed_attempt(username: str) -> None:
    """Increment failed_attempts; lock for 15 min after 5 consecutive failures."""
    table = get_table(settings.admin_users_table)
    resp = table.update_item(
        Key={"username": username},
        UpdateExpression="ADD failed_attempts :one",
        ExpressionAttributeValues={":one": 1},
        ReturnValues="ALL_NEW",
    )
    attrs = resp.get("Attributes", {})
    attempts = int(attrs.get("failed_attempts", 0))
    if attempts >= _MAX_ATTEMPTS:
        lock_until = int(time.time()) + _LOCK_SECONDS
        table.update_item(
            Key={"username": username},
            UpdateExpression="SET locked_until = :ts",
            ExpressionAttributeValues={":ts": lock_until},
        )


def clear_failed_attempts(username: str) -> None:
    """Reset failed_attempts and locked_until after a successful login."""
    table = get_table(settings.admin_users_table)
    table.update_item(
        Key={"username": username},
        UpdateExpression="REMOVE failed_attempts, locked_until",
    )


def verify_password(plain: str, hashed: str) -> bool:
    """Return True when *plain* matches the Argon2id *hashed* value."""
    try:
        return _ph.verify(hashed, plain)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def hash_password(plain: str) -> str:
    """Return an Argon2id hash of *plain*."""
    return _ph.hash(plain)


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def write_audit_log(
    actor: str,
    action: str,
    target: str,
    details: dict[str, Any],
    request: Request | None = None,
) -> None:
    """Write a single audit entry to DynamoDB (fire-and-forget; errors logged).

    Table schema: pk="audit", sk="{iso_timestamp}#{uuid}" (composite key).
    expires_at TTL = 90 days.
    """
    try:
        table = get_table(settings.audit_log_table)
        now = datetime.now(timezone.utc)
        iso = now.isoformat()
        sk = f"{iso}#{uuid.uuid4()}"
        item: dict[str, Any] = {
            "pk":        "audit",
            "sk":        sk,
            "actor":     actor,
            "action":    action,
            "target":    target,
            "details":   json.dumps(details),
            "timestamp": iso,
            "expires_at": int(now.timestamp()) + 90 * 86400,
        }
        if request is not None:
            item["sourceIp"] = request.client.host if request.client else "unknown"
            item["userAgent"] = request.headers.get("user-agent", "")
        table.put_item(Item=item)
    except Exception:
        logger.exception("Failed to write audit log entry")
