"""Authentication routes: login, logout, password change, MFA enrolment."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from app.auth import (
    clear_failed_attempts,
    create_token,
    current_user,
    hash_password,
    record_failed_attempt,
    verify_password,
    write_audit_log,
)
from app.deps import get_table
from app.settings import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

_COOKIE_NAME = "vid_admin_session"
_COOKIE_MAX_AGE = 8 * 3600


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    username: str
    password: str
    totp_code: str | None = None


class ChangePasswordRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    current_password: str
    new_password: str = Field(..., min_length=12)


class VerifyMfaRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    totp_code: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_user_or_401(username: str) -> dict[str, Any]:
    table = get_table(settings.admin_users_table)
    resp = table.get_item(Key={"username": username})
    item = resp.get("Item")
    if not item:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials",
        )
    return item


def _set_session_cookie(response: Response, token: str) -> None:
    from app.settings import settings
    response.set_cookie(
        key=_COOKIE_NAME,
        value=token,
        httponly=True,
        secure=settings.secure_cookie,
        samesite="lax",
        max_age=_COOKIE_MAX_AGE,
        path="/",
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/login")
async def login(
    req: LoginRequest,
    request: Request,
    response: Response,
) -> dict:
    import time

    table = get_table(settings.admin_users_table)
    resp = table.get_item(Key={"username": req.username})
    user = resp.get("Item")

    # Generic error for any auth failure (prevent user enumeration)
    _FAIL = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials",
    )

    if not user:
        raise _FAIL

    if user.get("disabled"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account disabled",
        )

    locked_until = user.get("locked_until")
    if locked_until and time.time() < float(locked_until):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account temporarily locked",
        )

    if not verify_password(req.password, user.get("password_hash", "")):
        record_failed_attempt(req.username)
        write_audit_log(req.username, "auth.login_failed", req.username, {"reason": "bad_password"}, request)
        raise _FAIL

    # TOTP verification when enrolled
    if user.get("mfa_enabled") or user.get("mfa_required"):
        if not req.totp_code:
            # Signal to the client that TOTP is required
            return {"mfa_required": True}
        totp_secret = user.get("totp_secret", "")
        totp = pyotp.TOTP(totp_secret)
        if not totp.verify(req.totp_code, valid_window=1):
            record_failed_attempt(req.username)
            write_audit_log(req.username, "auth.login_failed", req.username, {"reason": "bad_totp"}, request)
            raise _FAIL

    clear_failed_attempts(req.username)

    token = create_token(req.username)
    _set_session_cookie(response, token)

    # Update last_login
    table.update_item(
        Key={"username": req.username},
        UpdateExpression="SET last_login = :ts",
        ExpressionAttributeValues={":ts": datetime.now(timezone.utc).isoformat()},
    )

    write_audit_log(req.username, "auth.login", req.username, {}, request)
    return {"status": "ok", "username": req.username}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    user: dict = Depends(current_user),
) -> dict:
    response.delete_cookie(key=_COOKIE_NAME, path="/")
    write_audit_log(user["username"], "auth.logout", user["username"], {}, request)
    return {"status": "ok"}


@router.post("/change-password")
async def change_password(
    req: ChangePasswordRequest,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    import re
    _PASSWORD_RE = re.compile(
        r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>\/?]).{12,}$"
    )
    if not _PASSWORD_RE.match(req.new_password):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be at least 12 characters with upper, lower, digit, and special character.",
        )

    db_user = _get_user_or_401(user["username"])
    if not verify_password(req.current_password, db_user.get("password_hash", "")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Current password is incorrect",
        )

    table = get_table(settings.admin_users_table)
    table.update_item(
        Key={"username": user["username"]},
        UpdateExpression="SET password_hash = :h, password_changed_at = :ts",
        ExpressionAttributeValues={
            ":h": hash_password(req.new_password),
            ":ts": datetime.now(timezone.utc).isoformat(),
        },
    )
    write_audit_log(user["username"], "auth.change_password", user["username"], {}, request)
    return {"status": "ok"}


@router.get("/enroll-mfa")
async def enroll_mfa(
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    """Generate a new TOTP secret and return an otpauth:// URI for QR display."""
    db_user = _get_user_or_401(user["username"])
    secret = pyotp.random_base32()

    # Persist (not yet confirmed)
    table = get_table(settings.admin_users_table)
    table.update_item(
        Key={"username": user["username"]},
        UpdateExpression="SET totp_secret = :s, mfa_pending = :t",
        ExpressionAttributeValues={":s": secret, ":t": True},
    )

    totp = pyotp.TOTP(secret)
    issuer = f"EntraVID Admin ({settings.stage})"
    uri = totp.provisioning_uri(name=user["username"], issuer_name=issuer)
    return {"otpauth_uri": uri, "secret": secret}


@router.post("/verify-mfa")
async def verify_mfa(
    req: VerifyMfaRequest,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    """Confirm the TOTP code and activate MFA on the account."""
    db_user = _get_user_or_401(user["username"])
    secret = db_user.get("totp_secret")
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No MFA enrollment in progress. Call /auth/enroll-mfa first.",
        )

    totp = pyotp.TOTP(secret)
    if not totp.verify(req.totp_code, valid_window=1):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid TOTP code",
        )

    table = get_table(settings.admin_users_table)
    table.update_item(
        Key={"username": user["username"]},
        UpdateExpression="SET mfa_enabled = :t, mfa_required = :t REMOVE mfa_pending",
        ExpressionAttributeValues={":t": True},
    )
    write_audit_log(user["username"], "auth.mfa_enrolled", user["username"], {}, request)
    return {"status": "ok", "mfa_enabled": True}
