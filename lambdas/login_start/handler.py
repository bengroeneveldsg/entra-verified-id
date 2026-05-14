"""
login_start/handler.py — POST /api/login/start

Creates a Verified ID presentation request via the Microsoft Entra
Request Service API. Returns a QR code (base64 PNG) and a deep-link
URL for Microsoft Authenticator, plus the requestId that the frontend
must poll on /api/login/status/{requestId}.

Flow:
  1. Fetch client credentials from Secrets Manager (cached in module scope).
  2. Load config (tenant_id, callback_base_url, authority, accepted_issuer,
     client_name) from SystemConfig DynamoDB table.
  3. Exchange client credentials for an Azure AD access token.
  4. Call Entra createPresentationRequest; get back QR code + url.
  5. Persist a pending record in DynamoDB with a 10-minute TTL.
  6. Return QR code, deep-link url, and requestId to the caller.

Environment variables:
  STATE_TABLE          — DynamoDB table name
  SECRET_NAME          — Secrets Manager secret name
  SYSTEM_CONFIG_TABLE  — DynamoDB SystemConfig table name
  STAGE                — deployment stage (info only)
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from aws_lambda_powertools import Logger

logger = Logger()

# ── AWS singletons ────────────────────────────────────────────────────────────
_region = os.environ.get("AWS_REGION")
_dynamodb = boto3.resource("dynamodb", region_name=_region)
_secrets_boto = boto3.client("secretsmanager", region_name=_region)

# ── Env-var bootstrap pointers ────────────────────────────────────────────────
_STATE_TABLE: str = os.environ["STATE_TABLE"]
_SECRET_NAME: str = os.environ["SECRET_NAME"]
_SYSTEM_CONFIG_TABLE: str = os.environ["SYSTEM_CONFIG_TABLE"]

# ── TTL ───────────────────────────────────────────────────────────────────────
_TTL_SECONDS: int = 600  # 10 minutes

# ── Entra constants that never change ────────────────────────────────────────
# Microsoft-published app ID for Entra Verified ID — same in every tenant.
# Ref: https://learn.microsoft.com/en-us/entra/verified-id/verifiable-credentials-configure-issuer
ENTRA_VID_APP_ID = "3db474b9-6a0c-4840-96ac-1fceb342124f"
ENTRA_VID_SCOPE  = f"{ENTRA_VID_APP_ID}/.default"

_VC_API_URL: str = (
    "https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createPresentationRequest"
)

_secrets_cache: dict[str, str] | None = None
_secrets_cache_at: float = 0.0
_SECRETS_TTL: int = 300

_config_cache: dict[str, str] | None = None
_config_cache_at: float = 0.0
_CONFIG_TTL: int = 300

# ── Inline secrets helper ─────────────────────────────────────────────────────
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


# ── Inline config helper ──────────────────────────────────────────────────────

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
    """Exchange client credentials for an Azure AD bearer token."""
    token_endpoint = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": ENTRA_VID_SCOPE,
        }
    ).encode()
    req = urllib.request.Request(
        token_endpoint,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_data: dict[str, Any] = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode(errors="replace")
        logger.error("Token endpoint error", status=exc.code, body=error_body)
        raise RuntimeError(f"Failed to obtain access token: HTTP {exc.code}") from exc
    return token_data["access_token"]


def _create_presentation_request(
    access_token: str,
    request_id: str,
    callback_secret: str,
    callback_base_url: str,
    authority: str,
    accepted_issuer: str,
    client_name: str,
) -> dict[str, Any]:
    """Call Entra createPresentationRequest and return the full API response."""
    callback_url = f"{callback_base_url}/api/login/callback"
    payload = {
        "includeQRCode": True,
        "callback": {
            "url": callback_url,
            "state": request_id,
            "headers": {"x-api-key": callback_secret},
        },
        "authority": authority,
        "registration": {"clientName": client_name},
        "requestedCredentials": [
            {
                "type": "VerifiedEmployee",
                "purpose": "Sign in without a password",
                "acceptedIssuers": [accepted_issuer],
                "configuration": {
                    "validation": {
                        "allowRevoked": False,
                        "validateLinkedDomain": True,
                    }
                },
            }
        ],
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        _VC_API_URL,
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
        logger.error("createPresentationRequest error", status=exc.code, body=error_body)
        raise RuntimeError(
            f"Entra createPresentationRequest failed: HTTP {exc.code}"
        ) from exc


def _store_pending_request(request_id: str) -> None:
    """Write a pending record to DynamoDB with a 10-minute TTL."""
    table = _dynamodb.Table(_STATE_TABLE)
    now = int(time.time())
    table.put_item(
        Item={
            "requestId": request_id,
            "state": request_id,
            "status": "pending",
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
    """Handle POST /api/login/start."""
    if event.get("requestContext", {}).get("http", {}).get("method") == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

    request_id = str(uuid.uuid4())
    logger.info("Starting login request", extra={"requestId": request_id})

    try:
        # Load secrets
        client_id = _require_secret("clientId")
        client_secret = _require_secret("clientSecret")
        callback_secret = _require_secret("callbackSecret")

        # Load config
        tenant_id = _require_config("tenant_id")
        callback_base_url = _require_config("callback_base_url").rstrip("/")
        authority = _require_config("authority")
        accepted_issuer = _require_config("accepted_issuer")
        client_name = _require_config("client_name")

        access_token = _get_access_token(client_id, client_secret, tenant_id)
        vc_response = _create_presentation_request(
            access_token, request_id, callback_secret,
            callback_base_url, authority, accepted_issuer, client_name,
        )

        _store_pending_request(request_id)

        qr_raw: str = vc_response.get("qrCode", "")
        qr_base64 = qr_raw.removeprefix("data:image/png;base64,")

        response_body = {
            "requestId": request_id,
            "qrCode": qr_base64,
            "url": vc_response.get("url", ""),
        }
        logger.info("Presentation request created", extra={"requestId": request_id})
        return {
            "statusCode": 200,
            "headers": {**_cors_headers(), "Content-Type": "application/json"},
            "body": json.dumps(response_body),
        }

    except KeyError as exc:
        logger.error("Missing secret or config key", error=str(exc))
        return {
            "statusCode": 500,
            "headers": {**_cors_headers(), "Content-Type": "application/json"},
            "body": json.dumps({"error": "Service configuration error"}),
        }
    except RuntimeError as exc:
        logger.error("Runtime error during login start", error=str(exc))
        return {
            "statusCode": 502,
            "headers": {**_cors_headers(), "Content-Type": "application/json"},
            "body": json.dumps({"error": "Upstream service error"}),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error during login start")
        return {
            "statusCode": 500,
            "headers": {**_cors_headers(), "Content-Type": "application/json"},
            "body": json.dumps({"error": "Internal server error"}),
        }
