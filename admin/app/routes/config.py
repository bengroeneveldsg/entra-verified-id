"""System configuration routes."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from boto3.dynamodb.conditions import Key

from app.auth import current_user, write_audit_log
from app.deps import get_table
from app.models.system_config import UpdateConfigRequest
from app.settings import settings

router = APIRouter(prefix="/config", tags=["config"])

_SYSTEM_PK = "system"

# Keys whose values must be masked in the API response
_SENSITIVE_KEYS = frozenset({
    "private_key_pem",
    "previous_private_key_pem",
    "issuer_verifier_client_secret",
    "eam_provider_client_secret",
})

# Keys that are written by the setup wizard — should not be edited post-setup
_READ_ONLY_KEYS = frozenset({
    "onboarding_complete",
    "setup_admin_complete",
    "setup_tenant_complete",
    "setup_did_complete",
    "setup_domain_complete",
    "setup_keys_complete",
})


def _fix(val: object) -> object:
    """Convert DynamoDB Decimal to int/float for JSON serialisation."""
    if isinstance(val, Decimal):
        return int(val) if val == int(val) else float(val)
    if isinstance(val, dict):
        return {k: _fix(v) for k, v in val.items()}
    if isinstance(val, list):
        return [_fix(v) for v in val]
    return val


@router.get("/")
async def list_config(user: dict = Depends(current_user)) -> list[dict]:
    table = get_table(settings.system_config_table)
    # Query on pk="system" to get all config keys
    resp = table.query(KeyConditionExpression=Key("pk").eq(_SYSTEM_PK))
    items = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = table.query(
            KeyConditionExpression=Key("pk").eq(_SYSTEM_PK),
            ExclusiveStartKey=resp["LastEvaluatedKey"],
        )
        items.extend(resp.get("Items", []))

    result = []
    for item in items:
        key = item.get("sk", "")
        if key in _SENSITIVE_KEYS:
            continue  # omit from response entirely
        result.append({
            "key":        key,
            "value":      str(item.get("value", "")),
            "updated_at": item.get("updated_at", ""),
            "updated_by": item.get("updated_by", ""),
            "read_only":  key in _READ_ONLY_KEYS,
        })
    return sorted(result, key=lambda x: x["key"])


@router.put("/")
async def update_config(
    req: UpdateConfigRequest,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    if req.key in _SENSITIVE_KEYS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"'{req.key}' cannot be updated via the API.")
    if req.key in _READ_ONLY_KEYS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail=f"'{req.key}' is read-only.")

    table = get_table(settings.system_config_table)
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(Item={
        "pk":         _SYSTEM_PK,
        "sk":         req.key,
        "value":      req.value,
        "updated_at": now,
        "updated_by": user["username"],
    })
    write_audit_log(user["username"], "config.update", req.key,
                    {"new_value": req.value}, request)
    return {"key": req.key, "value": req.value, "updated_at": now, "updated_by": user["username"]}
