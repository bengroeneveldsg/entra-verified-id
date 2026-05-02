"""
Setup / onboarding wizard routes.

All POST endpoints are blocked once ``onboarding_complete=true``.
No JWT auth is required during the wizard — the routes are protected by
``_require_not_complete()`` which blocks them permanently after setup finishes.
``POST /admin-user`` is additionally protected by the bootstrap secret header.
"""
from __future__ import annotations

import json
import logging

from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException, Request, status

from app.models.setup import (
    SetupAdminUserRequest,
    SetupDidRequest,
    SetupDomainRequest,
    SetupKeysRequest,
    SetupStatusResponse,
    SetupTenantRequest,
)
from app.services import setup_service
from app.settings import settings
from app.deps import secrets_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/setup", tags=["setup"])


# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

def _require_not_complete() -> None:
    status_data = setup_service.get_setup_status()
    if status_data["onboarding_complete"]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Onboarding is already complete.",
        )


def _get_bootstrap_secret_value() -> str | None:
    """Read the bootstrap password from Secrets Manager."""
    try:
        resp = secrets_client.get_secret_value(SecretId=settings.bootstrap_secret_name)
        raw = resp.get("SecretString", "")
        try:
            data = json.loads(raw)
            return data.get("password", raw)
        except (json.JSONDecodeError, TypeError):
            return raw
    except ClientError:
        return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status", response_model=SetupStatusResponse)
async def get_status() -> SetupStatusResponse:
    data = setup_service.get_setup_status()
    return SetupStatusResponse(**data)


@router.post("/admin-user")
async def create_admin_user(
    req: SetupAdminUserRequest,
    request: Request,
) -> dict:
    """Bootstrap endpoint — no JWT. Protected by X-Bootstrap-Token header."""
    _require_not_complete()

    expected = _get_bootstrap_secret_value()
    provided = request.headers.get("X-Bootstrap-Token", "")
    if not expected or provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing bootstrap token",
        )

    try:
        result = setup_service.setup_admin_user(req)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc

    logger.info("setup.admin_user completed")
    return result


@router.post("/tenant")
async def configure_tenant(req: SetupTenantRequest, request: Request) -> dict:
    _require_not_complete()
    try:
        result = setup_service.setup_tenant(req)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info("setup.tenant completed for tenant %s", req.tenant_id)
    return result


@router.post("/did")
async def configure_did(req: SetupDidRequest, request: Request) -> dict:
    _require_not_complete()
    try:
        result = setup_service.setup_did(req)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info("setup.did completed for authority %s", req.authority)
    return result


@router.post("/domain")
async def configure_domain(req: SetupDomainRequest, request: Request) -> dict:
    _require_not_complete()
    result = setup_service.setup_domain(req)
    logger.info("setup.domain completed for %s", req.public_domain)
    return result


@router.post("/keys")
async def configure_keys(req: SetupKeysRequest, request: Request) -> dict:
    _require_not_complete()
    result = setup_service.setup_keys(req)
    logger.info("setup.keys completed kid=%s", result.get("kid", ""))
    return result


@router.post("/complete")
async def complete_setup(request: Request) -> dict:
    _require_not_complete()
    try:
        result = setup_service.setup_complete(actor="wizard")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    logger.info("setup.complete: onboarding finished")
    return result
