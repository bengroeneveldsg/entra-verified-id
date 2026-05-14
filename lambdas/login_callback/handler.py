"""
login_callback/handler.py — POST /api/login/callback

Receives the Verified ID service webhook when a user presents their
credential in Microsoft Authenticator.

Security validation performed (in order):
  1. x-api-key header must match callbackSecret from Secrets Manager.
  2. state in the body must correspond to a known pending record in DynamoDB.
  3. The record must still be in 'pending' state (idempotency guard).

Environment variables:
  STATE_TABLE          — DynamoDB table name
  SECRET_NAME          — Secrets Manager secret name
  SYSTEM_CONFIG_TABLE  — DynamoDB SystemConfig table name (not used here but set)
  STAGE                — deployment stage (info only)
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr
from aws_lambda_powertools import Logger

logger = Logger()

# ── AWS singletons ────────────────────────────────────────────────────────────
_region = os.environ.get("AWS_REGION")
_dynamodb = boto3.resource("dynamodb", region_name=_region)
_secrets_boto = boto3.client("secretsmanager", region_name=_region)

# ── Env-var bootstrap pointers ────────────────────────────────────────────────
_STATE_TABLE: str = os.environ["STATE_TABLE"]
_SECRET_NAME: str = os.environ["SECRET_NAME"]

# ── Entra status strings ──────────────────────────────────────────────────────
_STATUS_RETRIEVED = "request_retrieved"
_STATUS_VERIFIED  = "presentation_verified"
_STATUS_ERROR     = "presentation_error"

# ── Module-level secrets cache ────────────────────────────────────────────────
_secrets_cache: dict[str, str] | None = None
_secrets_cache_at: float = 0.0
_SECRETS_TTL: int = 300

_EXTENSION_PORT = "2773"


def _get_secret() -> dict[str, str]:
    global _secrets_cache, _secrets_cache_at
    now = time.time()
    if _secrets_cache is not None and (now - _secrets_cache_at) < _SECRETS_TTL:
        return _secrets_cache
    try:
        quoted = urllib.parse.quote(_SECRET_NAME, safe="")
        req = urllib.request.Request(
            f"http://localhost:{_EXTENSION_PORT}/secretsmanager/get?secretId={quoted}",
            headers={"X-Aws-Parameters-Secrets-Token": os.environ.get("AWS_SESSION_TOKEN", "")},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            body = json.loads(resp.read())
        data: dict[str, str] = json.loads(body["SecretString"])
    except Exception:
        resp2 = _secrets_boto.get_secret_value(SecretId=_SECRET_NAME)
        data = json.loads(resp2["SecretString"])
    _secrets_cache = data
    _secrets_cache_at = now
    return data


def _require_secret(key: str) -> str:
    val = _get_secret().get(key, "")
    if not val or val == "PENDING_SETUP":
        raise RuntimeError(f"Secret not initialised (key={key!r})")
    return val


# ── Helpers ───────────────────────────────────────────────────────────────────

def _validate_api_key(event: dict[str, Any], expected: str) -> bool:
    """Constant-time comparison of the x-api-key header."""
    headers: dict[str, str] = {
        k.lower(): v for k, v in (event.get("headers") or {}).items()
    }
    received = headers.get("x-api-key", "")
    if len(received) != len(expected):
        return False
    result = 0
    for a, b in zip(received.encode(), expected.encode()):
        result |= a ^ b
    return result == 0


def _get_pending_record(request_id: str) -> dict[str, Any] | None:
    """Fetch the DynamoDB record; return None if absent or TTL-expired."""
    table = _dynamodb.Table(_STATE_TABLE)
    response = table.get_item(Key={"requestId": request_id})
    item: dict[str, Any] | None = response.get("Item")
    if item is None:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        logger.warning("Callback received for expired requestId", requestId=request_id)
        return None
    return item


def _update_record_success(request_id: str, claims: dict[str, Any], subject: str) -> None:
    table = _dynamodb.Table(_STATE_TABLE)
    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression=(
            "SET #st = :success, claims = :claims, #sub = :subject, updatedAt = :now"
        ),
        ConditionExpression=Attr("status").eq("pending"),
        ExpressionAttributeNames={"#st": "status", "#sub": "subject"},
        ExpressionAttributeValues={
            ":success": "success",
            ":claims": claims,
            ":subject": subject,
            ":now": int(time.time()),
        },
    )


def _update_record_failed(request_id: str, reason: str) -> None:
    table = _dynamodb.Table(_STATE_TABLE)
    table.update_item(
        Key={"requestId": request_id},
        UpdateExpression="SET #st = :failed, failureReason = :reason, updatedAt = :now",
        ConditionExpression=Attr("status").eq("pending"),
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={
            ":failed": "failed",
            ":reason": reason,
            ":now": int(time.time()),
        },
    )


# ── Handler ───────────────────────────────────────────────────────────────────

@logger.inject_lambda_context
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Handle POST /api/login/callback from the Entra Verified ID service.

    Always returns 200 to Entra (webhook contract), unless x-api-key fails (401)
    or the body is unparseable (400).
    """
    # ── 1. Validate API key ───────────────────────────────────────────────────
    try:
        expected_secret = _require_secret("callbackSecret")
    except Exception:
        logger.exception("Failed to retrieve callback secret")
        return {"statusCode": 500, "body": "Service error"}

    if not _validate_api_key(event, expected_secret):
        logger.warning("Callback received with invalid x-api-key")
        return {"statusCode": 401, "body": "Unauthorized"}

    # ── 2. Parse body ─────────────────────────────────────────────────────────
    raw_body: str = event.get("body") or ""
    try:
        payload: dict[str, Any] = json.loads(raw_body)
    except json.JSONDecodeError:
        logger.error("Callback body is not valid JSON")
        return {"statusCode": 400, "body": "Bad request"}

    request_status: str = payload.get("requestStatus", "")
    state: str = payload.get("state", "")

    logger.info("Callback received", extra={"state": state, "requestStatus": request_status})

    if request_status == _STATUS_RETRIEVED:
        logger.info("QR code scanned by user", extra={"state": state})
        return {"statusCode": 200, "body": "ok"}

    if not state:
        logger.error("Callback missing state field")
        return {"statusCode": 200, "body": "ok"}

    # ── 3. Validate state against DynamoDB ────────────────────────────────────
    record = _get_pending_record(state)
    if record is None:
        logger.warning("No pending record found for state", extra={"state": state})
        return {"statusCode": 200, "body": "ok"}

    if record.get("state") != state:
        logger.error(
            "State mismatch",
            extra={"stored": record.get("state"), "echoed": state},
        )
        return {"statusCode": 200, "body": "ok"}

    # ── 4. Process verified / error ───────────────────────────────────────────
    try:
        if request_status == _STATUS_VERIFIED:
            vc_data_list: list[dict[str, Any]] = payload.get("verifiedCredentialsData", [])
            merged_claims: dict[str, Any] = {}
            for vc in vc_data_list:
                merged_claims.update(vc.get("claims", {}))
            subject: str = payload.get("subject", "")
            logger.info(
                "Credential verified",
                extra={
                    "state": state,
                    "subjectPrefix": subject[:20] if subject else "unknown",
                },
            )
            _update_record_success(state, merged_claims, subject)

        elif request_status == _STATUS_ERROR:
            error_details: dict[str, Any] = payload.get("error", {})
            reason: str = error_details.get("message", "unknown error")
            logger.info(
                "Credential presentation failed",
                extra={"state": state, "reason": reason},
            )
            _update_record_failed(state, reason)

        else:
            logger.warning(
                "Unhandled requestStatus",
                extra={"requestStatus": request_status, "state": state},
            )

    except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.info("Idempotency guard: record already processed", extra={"state": state})
    except Exception:
        logger.exception("Error updating DynamoDB record", extra={"state": state})

    return {"statusCode": 200, "body": "ok"}
