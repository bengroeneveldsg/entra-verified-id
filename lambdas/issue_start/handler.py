"""
issue_start/handler.py — POST /api/issue/start

Creates a Verified ID issuance request via the Microsoft Entra
Request Service API. Returns a QR code (base64 PNG), deep-link URL,
and requestId for polling.

Environment variables:
  STATE_TABLE          — DynamoDB table name
  SECRET_NAME          — Secrets Manager secret name
  SYSTEM_CONFIG_TABLE  — DynamoDB SystemConfig table name
  STAGE                — deployment stage (info only)
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from aws_lambda_powertools import Logger

# Microsoft-published app ID for Entra Verified ID — same in every tenant.
# Ref: https://learn.microsoft.com/en-us/entra/verified-id/verifiable-credentials-configure-issuer
ENTRA_VID_APP_ID = "3db474b9-6a0c-4840-96ac-1fceb342124f"
ENTRA_VID_SCOPE  = f"{ENTRA_VID_APP_ID}/.default"

logger = Logger()

# ── AWS singletons ────────────────────────────────────────────────────────────
_region = os.environ.get("AWS_REGION")
_dynamodb = boto3.resource("dynamodb", region_name=_region)
_secrets_boto = boto3.client("secretsmanager", region_name=_region)

# ── Env-var bootstrap pointers ────────────────────────────────────────────────
_STATE_TABLE: str = os.environ["STATE_TABLE"]
_SECRET_NAME: str = os.environ["SECRET_NAME"]
_SYSTEM_CONFIG_TABLE: str = os.environ["SYSTEM_CONFIG_TABLE"]

# ── TTL / constants ───────────────────────────────────────────────────────────
_TTL_SECONDS: int = 600
_VID_SCOPE: str = ENTRA_VID_SCOPE
_ISSUANCE_API_URL: str = (
    "https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createIssuanceRequest"
)

# ── Module-level caches ───────────────────────────────────────────────────────
_secrets_cache: dict[str, str] | None = None
_secrets_cache_at: float = 0.0
_SECRETS_TTL: int = 300

_config_cache: dict[str, str] | None = None
_config_cache_at: float = 0.0
_CONFIG_TTL: int = 300

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


def _get_config() -> dict[str, str]:
    global _config_cache, _config_cache_at
    now = time.time()
    if _config_cache is not None and (now - _config_cache_at) < _CONFIG_TTL:
        return _config_cache
    table = _dynamodb.Table(_SYSTEM_CONFIG_TABLE)
    resp = table.query(KeyConditionExpression=Key("pk").eq("system"))
    result: dict[str, str] = {}
    for item in resp.get("Items", []):
        result[item["sk"]] = item.get("value", "")
    _config_cache = result
    _config_cache_at = now
    return result


def _require_config(key: str) -> str:
    val = _get_config().get(key, "")
    if not val or val == "PENDING_SETUP":
        raise RuntimeError(f"System config not initialised (key={key!r})")
    return val


# ── Business logic ────────────────────────────────────────────────────────────

def _get_access_token(client_id: str, client_secret: str, tenant_id: str) -> str:
    token_endpoint = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": _VID_SCOPE,
        }
    ).encode()
    req = urllib.request.Request(
        token_endpoint,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())["access_token"]



def _create_issuance_request(
    access_token: str,
    request_id: str,
    callback_secret: str,
    callback_base_url: str,
    authority: str,
    manifest_url: str,
    client_name: str,
) -> dict[str, Any]:
    callback_url = f"{callback_base_url}/api/issue/callback"
    payload = {
        "includeQRCode": True,
        "callback": {
            "url": callback_url,
            "state": request_id,
            "headers": {"x-api-key": callback_secret},
        },
        "authority": authority,
        "registration": {"clientName": client_name},
        "type": "VerifiedEmployee",
        "manifest": manifest_url,
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        _ISSUANCE_API_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode(errors="replace")
        logger.error("createIssuanceRequest error", status=exc.code, body=error_body)
        raise RuntimeError(f"Entra createIssuanceRequest failed: HTTP {exc.code}") from exc


def _store_pending_request(request_id: str) -> None:
    table = _dynamodb.Table(_STATE_TABLE)
    now = int(time.time())
    table.put_item(
        Item={
            "requestId": request_id,
            "state": request_id,
            "status": "pending",
            "flow": "issuance",
            "createdAt": now,
            "ttl": now + _TTL_SECONDS,
        }
    )


def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
    }


# ── Handler ───────────────────────────────────────────────────────────────────

@logger.inject_lambda_context
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Handle POST /api/issue/start."""
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

    try:
        # Load secrets
        client_id = _require_secret("clientId")
        client_secret = _require_secret("clientSecret")
        callback_secret = _require_secret("callbackSecret")

        # Load config
        tenant_id = _require_config("tenant_id")
        callback_base_url = _require_config("callback_base_url").rstrip("/")
        authority = _require_config("authority")
        manifest_url = _require_config("manifest_url")
        client_name = _require_config("client_name")

        access_token = _get_access_token(client_id, client_secret, tenant_id)
        request_id = str(uuid.uuid4())

        logger.info("Starting issuance request", extra={"requestId": request_id})

        api_response = _create_issuance_request(
            access_token, request_id, callback_secret,
            callback_base_url, authority, manifest_url, client_name,
        )
        _store_pending_request(request_id)

        return {
            "statusCode": 200,
            "headers": {**_cors_headers(), "Content-Type": "application/json"},
            "body": json.dumps(
                {
                    "requestId": request_id,
                    "qrCode": api_response.get("qrCode", "").removeprefix(
                        "data:image/png;base64,"
                    ),
                    "url": api_response.get("url", ""),
                }
            ),
        }

    except Exception:
        logger.exception("issue_start failed")
        return {
            "statusCode": 500,
            "headers": {**_cors_headers(), "Content-Type": "application/json"},
            "body": json.dumps({"error": "Internal server error"}),
        }
