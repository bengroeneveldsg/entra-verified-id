"""
issue_callback/handler.py — POST /api/issue/callback

Receives issuance status callbacks from the Microsoft Entra Verified ID service.
Validates the x-api-key header and state field, then writes the result to DynamoDB.

Entra issuance callback states:
  request_retrieved   — user scanned the QR code
  issuance_successful — credential successfully issued to wallet
  issuance_error      — issuance failed

Environment variables:
  STATE_TABLE          — DynamoDB table name
  SECRET_NAME          — Secrets Manager secret name
  SYSTEM_CONFIG_TABLE  — DynamoDB SystemConfig table name (set for consistency)
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
_region = os.environ.get("AWS_REGION", "ap-southeast-1")
_dynamodb = boto3.resource("dynamodb", region_name=_region)
_secrets_boto = boto3.client("secretsmanager", region_name=_region)

# ── Env-var bootstrap pointers ────────────────────────────────────────────────
_STATE_TABLE: str = os.environ["STATE_TABLE"]
_SECRET_NAME: str = os.environ["SECRET_NAME"]

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


def _constant_time_compare(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    result = 0
    for x, y in zip(a.encode(), b.encode()):
        result |= x ^ y
    return result == 0


# ── Handler ───────────────────────────────────────────────────────────────────

@logger.inject_lambda_context
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Handle POST /api/issue/callback from the Entra Verified ID service."""
    # Validate api-key
    try:
        expected_key = _require_secret("callbackSecret")
        provided_key = (event.get("headers") or {}).get("x-api-key", "")
        if not _constant_time_compare(provided_key, expected_key):
            logger.warning("Invalid x-api-key on issuance callback")
            return {"statusCode": 401, "body": "Unauthorized"}
    except Exception:
        logger.exception("Secret fetch failed")
        return {"statusCode": 500, "body": "Internal error"}

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return {"statusCode": 400, "body": "Bad JSON"}

    request_status = body.get("requestStatus", "")
    state = body.get("state", "")

    logger.info("Issuance callback", extra={"requestStatus": request_status, "state": state})

    table = _dynamodb.Table(_STATE_TABLE)

    if request_status == "request_retrieved":
        try:
            table.update_item(
                Key={"requestId": state},
                UpdateExpression="SET #s = :s",
                ConditionExpression=Attr("status").eq("pending"),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={":s": "request_retrieved"},
            )
        except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
            pass  # already updated — idempotent
        return {"statusCode": 200, "body": "ok"}

    if request_status == "issuance_successful":
        try:
            table.update_item(
                Key={"requestId": state},
                UpdateExpression="SET #s = :s, issuedAt = :t",
                ConditionExpression=Attr("status").ne("issuance_successful"),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "issuance_successful",
                    ":t": int(time.time()),
                },
            )
            logger.info("Credential issued successfully", extra={"state": state})
        except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
            logger.info("Issuance already recorded", extra={"state": state})
        return {"statusCode": 200, "body": "ok"}

    if request_status == "issuance_error":
        error = body.get("error", {})
        logger.error("Issuance error", extra={"state": state, "error": error})
        try:
            table.update_item(
                Key={"requestId": state},
                UpdateExpression="SET #s = :s, errorMsg = :e",
                ConditionExpression=Attr("status").ne("issuance_successful"),
                ExpressionAttributeNames={"#s": "status"},
                ExpressionAttributeValues={
                    ":s": "issuance_error",
                    ":e": error.get("message", "Unknown error"),
                },
            )
        except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
            pass
        return {"statusCode": 200, "body": "ok"}

    logger.warning("Unhandled issuance status", extra={"requestStatus": request_status})
    return {"statusCode": 200, "body": "ok"}
