"""VID session management routes."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from boto3.dynamodb.conditions import Attr
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.auth import current_user, write_audit_log
from app.deps import get_table
from app.settings import settings

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get("/")
async def list_sessions(
    user: dict = Depends(current_user),
) -> list[dict]:
    """Return active sessions — pending/in-progress and not yet TTL-expired."""
    table = get_table(settings.state_table)
    now_epoch = int(time.time())
    # Include all non-terminal statuses; filter out TTL-expired records DynamoDB hasn't purged yet
    active_statuses = ["pending", "request_created", "request_retrieved"]
    filter_expr = (
        Attr("status").is_in(active_statuses)
        & Attr("ttl").gt(now_epoch)
    )
    resp = table.scan(FilterExpression=filter_expr)
    items = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = table.scan(
            ExclusiveStartKey=resp["LastEvaluatedKey"],
            FilterExpression=filter_expr,
        )
        items.extend(resp.get("Items", []))
    return sorted(items, key=lambda x: x.get("createdAt", ""), reverse=True)


@router.delete("/{request_id}")
async def revoke_session(
    request_id: str,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    """Revoke a session by setting its status to 'revoked'."""
    table = get_table(settings.state_table)
    resp = table.get_item(Key={"requestId": request_id})
    item = resp.get("Item")
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session '{request_id}' not found",
        )

    now = datetime.now(timezone.utc).isoformat()
    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET #s = :revoked, revokedAt = :ts, revokedBy = :by",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":revoked": "revoked",
            ":ts": now,
            ":by": user["username"],
        },
    )
    write_audit_log(
        user["username"],
        "session.revoke",
        request_id,
        {},
        request,
    )
    return {"status": "revoked", "requestId": request_id}
