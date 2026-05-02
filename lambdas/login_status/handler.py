"""
login_status/handler.py — GET /api/login/status/{requestId}

Polled by the frontend every ~2 seconds after login_start returns.
Returns the current state of a presentation request.

Claims are returned once per request: a successful record is transitioned
to 'claimed' after the first read so the JWT/session is issued exactly once.

Environment variables:
  STATE_TABLE          — DynamoDB table name
  SECRET_NAME          — Secrets Manager secret name (unused here, set for consistency)
  SYSTEM_CONFIG_TABLE  — DynamoDB SystemConfig table name (unused here)
  STAGE                — deployment stage (info only)
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr
from aws_lambda_powertools import Logger

logger = Logger()

# ── AWS singletons ────────────────────────────────────────────────────────────
_region = os.environ.get("AWS_REGION", "ap-southeast-1")
_dynamodb = boto3.resource("dynamodb", region_name=_region)

# ── Env-var bootstrap pointers ────────────────────────────────────────────────
_STATE_TABLE: str = os.environ["STATE_TABLE"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
    }


def _json_response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {**_cors_headers(), "Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _get_record(request_id: str) -> dict[str, Any] | None:
    """Fetch DynamoDB item; return None if absent or TTL-expired."""
    table = _dynamodb.Table(_STATE_TABLE)
    response = table.get_item(
        Key={"requestId": request_id},
        ProjectionExpression="#st, claims, failureReason, #ttl, #sub",
        ExpressionAttributeNames={
            "#st": "status",
            "#ttl": "ttl",
            "#sub": "subject",
        },
    )
    item: dict[str, Any] | None = response.get("Item")
    if item is None:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        return None
    return item


def _mark_claimed(request_id: str) -> None:
    """Atomically transition 'success' -> 'claimed' so claims are returned once."""
    table = _dynamodb.Table(_STATE_TABLE)
    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET #st = :claimed",
        ConditionExpression=Attr("status").eq("success"),
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={":claimed": "claimed"},
    )


# ── Handler ───────────────────────────────────────────────────────────────────

@logger.inject_lambda_context
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Handle GET /api/login/status/{requestId}."""
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

    path_params: dict[str, str] = event.get("pathParameters") or {}
    request_id: str = path_params.get("requestId", "").strip()

    if not request_id:
        return _json_response(400, {"error": "Missing requestId"})

    if len(request_id) > 128 or not all(c in "-0123456789abcdefABCDEF" for c in request_id):
        return _json_response(400, {"error": "Invalid requestId format"})

    logger.info("Status check", extra={"requestId": request_id})

    record = _get_record(request_id)
    if record is None:
        return _json_response(404, {"error": "Request not found or expired"})

    status: str = record.get("status", "pending")

    if status == "pending":
        return _json_response(200, {"status": "pending"})

    if status == "failed":
        return _json_response(
            200,
            {
                "status": "failed",
                "failureReason": record.get("failureReason", "Presentation failed"),
            },
        )

    if status == "success":
        claims: dict[str, Any] = record.get("claims", {})
        subject: str = record.get("subject", "")
        try:
            _mark_claimed(request_id)
        except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
            logger.info(
                "Race on claim; returning pending",
                extra={"requestId": request_id},
            )
            return _json_response(200, {"status": "pending"})
        except Exception:
            logger.exception("Failed to mark as claimed", extra={"requestId": request_id})
            return _json_response(500, {"error": "Internal server error"})

        return _json_response(
            200,
            {
                "status": "success",
                "claims": claims,
                "subject": subject,
            },
        )

    if status == "claimed":
        return _json_response(200, {"status": "claimed"})

    # Issuance-specific statuses — treat as pending (waiting for Entra to complete)
    if status in ("request_retrieved", "issuance_successful", "issuance_error"):
        return _json_response(200, {"status": status})

    logger.error(
        "Unexpected status",
        extra={"status": status, "requestId": request_id},
    )
    return _json_response(500, {"error": "Internal server error"})
