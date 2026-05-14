"""Signing key management routes."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth import current_user, write_audit_log
from app.deps import get_table, secrets_client
from app.services.key_service import rotate_keys
from app.settings import settings

router = APIRouter(prefix="/keys", tags=["keys"])

_SYSTEM_PK = "system"


def _get_config(sk: str) -> str | None:
    """Read one SystemConfig item using the correct composite key."""
    table = get_table(settings.system_config_table)
    resp = table.get_item(Key={"pk": _SYSTEM_PK, "sk": sk})
    item = resp.get("Item")
    return item["value"] if item else None


def _put_config(sk: str, value: str, actor: str = "system") -> None:
    table = get_table(settings.system_config_table)
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(Item={"pk": _SYSTEM_PK, "sk": sk, "value": value,
                         "updated_at": now, "updated_by": actor})


@router.get("/")
async def get_keys(user: dict = Depends(current_user)) -> dict:
    kid         = _get_config("kid")
    created_at  = _get_config("key_created_at") or _get_config("key_rotated_at")

    # Build JWKS URL from the domain config if available
    public_domain = _get_config("public_domain")
    if public_domain:
        jwks_url = f"https://{public_domain}/.well-known/jwks.json"
        oidc_url = f"https://{public_domain}/.well-known/openid-configuration"
    else:
        bucket = settings.hosting_bucket
        region = settings.aws_region or ""
        jwks_url = f"https://{bucket}.s3.{region}.amazonaws.com/.well-known/jwks.json"
        oidc_url = f"https://{bucket}.s3.{region}.amazonaws.com/.well-known/openid-configuration"

    return {
        "kid":             kid,
        "created_at":      created_at,
        "jwks_url":        jwks_url,
        "oidc_config_url": oidc_url,
    }


@router.post("/rotate")
async def rotate(request: Request, user: dict = Depends(current_user)) -> dict:
    result = rotate_keys()
    now = datetime.now(timezone.utc).isoformat()
    _put_config("kid",            result["kid"],      actor=user["username"])
    _put_config("key_rotated_at", now,                actor=user["username"])

    write_audit_log(
        user["username"], "keys.rotate", result["kid"],
        {"previous_kid": result.get("previous_kid")}, request,
    )
    return result
