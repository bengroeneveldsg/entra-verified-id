"""
Setup / onboarding wizard service.

Each step is idempotent – re-running a step overwrites the previous value.
All steps are gated on ``onboarding_complete=false``.
"""
from __future__ import annotations

import json
import logging
import secrets as python_secrets
from datetime import datetime, timezone
from typing import Any

import requests as http_requests
from botocore.exceptions import ClientError

from app.auth import hash_password
from app.deps import get_table, s3_client, secrets_client
from app.models.setup import (
    SetupAdminUserRequest,
    SetupDidRequest,
    SetupDomainRequest,
    SetupKeysRequest,
    SetupTenantRequest,
)
from app.services.key_service import bootstrap_keys
from app.settings import settings

logger = logging.getLogger(__name__)

# Microsoft-published constants — identical across every Entra tenant.
# Source: https://learn.microsoft.com/en-us/entra/verified-id/verifiable-credentials-configure-issuer
ENTRA_VID_APP_ID = "3db474b9-6a0c-4840-96ac-1fceb342124f"
ENTRA_VID_SCOPE  = f"{ENTRA_VID_APP_ID}/.default"

# SystemConfig table uses composite key: pk="system", sk=<config_key>
_SYSTEM_PK = "system"
ONBOARDING_COMPLETE_KEY = "onboarding_complete"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _put_config(key: str, value: str, actor: str = "system") -> None:
    table = get_table(settings.system_config_table)
    table.put_item(
        Item={
            "pk": _SYSTEM_PK,
            "sk": key,
            "value": value,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": actor,
        }
    )


def _get_config(key: str) -> str | None:
    table = get_table(settings.system_config_table)
    resp = table.get_item(Key={"pk": _SYSTEM_PK, "sk": key})
    item = resp.get("Item")
    return item["value"] if item else None


def _bootstrap_secret_exists() -> bool:
    try:
        secrets_client.describe_secret(SecretId=settings.bootstrap_secret_name)
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("ResourceNotFoundException", "InvalidRequestException"):
            return False
        raise


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_setup_status() -> dict[str, Any]:
    """
    Inspect SystemConfig to determine onboarding state.

    Steps considered complete:
      1. admin user exists (AdminUsers table non-empty)
      2. tenant config present
      3. DID config present
      4. domain config present
      5. keys bootstrapped
    """
    onboarding_complete = _get_config(ONBOARDING_COMPLETE_KEY) == "true"

    # Count completed steps
    step_keys = [
        "setup_admin_complete",
        "setup_tenant_complete",
        "setup_did_complete",
        "setup_domain_complete",
        "setup_keys_complete",
    ]
    current_step = 0
    for sk in step_keys:
        if _get_config(sk) == "true":
            current_step += 1
        else:
            break

    return {
        "onboarding_complete": onboarding_complete,
        "current_step": current_step,
        "has_bootstrap_secret": _bootstrap_secret_exists(),
    }


def setup_admin_user(req: SetupAdminUserRequest) -> dict[str, str]:
    """
    Create the first admin user.  Fails if any users already exist.
    Deletes the bootstrap secret on success.
    """
    table = get_table(settings.admin_users_table)

    # Guard: ensure no users exist yet
    scan = table.scan(Limit=1, ProjectionExpression="username")
    if scan.get("Items"):
        raise ValueError("Admin user already exists. This step cannot be repeated.")

    table.put_item(
        Item={
            "username": req.email,
            "password_hash": hash_password(req.password),
            "email": req.email,
            "mfa_enabled": False,
            "disabled": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    )

    # Delete bootstrap secret
    try:
        secrets_client.delete_secret(
            SecretId=settings.bootstrap_secret_name,
            ForceDeleteWithoutRecovery=True,
        )
    except ClientError:
        logger.warning("Could not delete bootstrap secret (may not exist)")

    _put_config("setup_admin_complete", "true", actor=req.email)
    return {"status": "ok", "username": req.email}


def _validate_entra_credentials(
    tenant_id: str,
    client_id: str,
    client_secret: str,
    scope: str = ENTRA_VID_SCOPE,
) -> bool:
    """
    Try to acquire a client_credentials token against the Entra token endpoint.
    Returns True if successful, raises ValueError on failure.
    """
    url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    resp = http_requests.post(
        url,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": scope,
        },
        timeout=10,
    )
    if resp.status_code == 200 and "access_token" in resp.json():
        return True
    raise ValueError(
        f"Entra credential validation failed: {resp.status_code} – {resp.text[:200]}"
    )


def setup_tenant(req: SetupTenantRequest) -> dict[str, str]:
    """Validate Entra credentials, write config and secrets."""
    # Validate issuer/verifier credentials
    _validate_entra_credentials(
        req.tenant_id,
        req.issuer_verifier_client_id,
        req.issuer_verifier_client_secret,
    )

    # Write non-secret values to SystemConfig
    _put_config("tenant_id", req.tenant_id)
    _put_config("issuer_verifier_client_id", req.issuer_verifier_client_id)

    # Write secrets to Secrets Manager (merge into existing secret)
    try:
        resp = secrets_client.get_secret_value(SecretId=settings.app_secret_name)
        secret_data = json.loads(resp.get("SecretString", "{}"))
    except ClientError:
        secret_data = {}

    secret_data['clientId'] = req.issuer_verifier_client_id
    secret_data['clientSecret'] = req.issuer_verifier_client_secret
    if not secret_data.get('callbackSecret') or secret_data.get('callbackSecret') == 'PENDING_SETUP':
        secret_data['callbackSecret'] = python_secrets.token_urlsafe(32)
    # Remove old/PENDING_SETUP keys
    for k in ['issuer_verifier_client_secret']:
        secret_data.pop(k, None)
    for k, v in list(secret_data.items()):
        if v == 'PENDING_SETUP':
            del secret_data[k]

    try:
        secrets_client.update_secret(
            SecretId=settings.app_secret_name,
            SecretString=json.dumps(secret_data),
        )
    except ClientError:
        secrets_client.create_secret(
            Name=settings.app_secret_name,
            SecretString=json.dumps(secret_data),
        )

    _put_config("setup_tenant_complete", "true")
    return {"status": "ok"}


def _validate_did_document(authority: str) -> bool:
    """
    Fetch the DID document from *authority* and do a basic sanity check.
    Raises ValueError on failure.
    """
    # Convert did:web to an HTTPS URL per the DID Web spec:
    # did:web:host         → https://host/.well-known/did.json
    # did:web:host:a:b:c  → https://host/a/b/c/did.json
    if authority.startswith("did:web:"):
        parts = authority[len("did:web:"):].split(":")
        host = parts[0]
        path_segments = parts[1:]
        if path_segments:
            url = f"https://{host}/{'/'.join(path_segments)}/did.json"
        else:
            url = f"https://{host}/.well-known/did.json"
    else:
        url = authority

    try:
        resp = http_requests.get(url, timeout=10)
        resp.raise_for_status()
        doc = resp.json()
        if "@context" not in doc and "id" not in doc:
            raise ValueError("Response does not look like a DID document")
    except http_requests.RequestException as exc:
        raise ValueError(f"Could not fetch DID document from {url}: {exc}") from exc
    return True


def setup_did(req: SetupDidRequest) -> dict[str, str]:
    """Validate the DID document and write DID config to SystemConfig."""
    _validate_did_document(req.authority)

    _put_config("did_authority", req.authority)  # keep for display
    _put_config("authority", req.authority)       # Lambda reads this
    _put_config("manifest_url", req.manifest_url)
    _put_config("accepted_issuer", req.accepted_issuer)
    _put_config("setup_did_complete", "true")
    return {"status": "ok"}


def setup_domain(req: SetupDomainRequest) -> dict[str, str]:
    """Write domain config and upload config.json to the hosting bucket."""
    _put_config("public_domain", req.public_domain)
    _put_config("api_domain", req.api_domain)
    _put_config("frontend_base_url", req.frontend_base_url)
    _put_config("client_name", req.client_name)

    # Upload frontend config.json
    config_obj = {
        "apiDomain": req.api_domain,
        "frontendBaseUrl": req.frontend_base_url,
        "clientName": req.client_name,
        "publicDomain": req.public_domain,
    }
    s3_client.put_object(
        Bucket=settings.hosting_bucket,
        Key="config.json",
        Body=json.dumps(config_obj, indent=2).encode(),
        ContentType="application/json",
    )

    api_url = req.api_domain if req.api_domain.startswith('http') else f"https://{req.api_domain}"
    _put_config("callback_base_url", api_url)          # Lambda needs full URL
    _put_config("issuer", req.frontend_base_url)       # OIDC issuer = frontend URL
    _put_config("entity_id", f"https://{req.public_domain}/saml")
    _put_config("saml_jwks_url", f"https://{req.public_domain}/.well-known/jwks.json")
    _put_config("saml_sso_url", f"{api_url}/api/saml/sso")

    _put_config("setup_domain_complete", "true")
    return {"status": "ok"}


def setup_keys(req: SetupKeysRequest) -> dict[str, Any]:
    """Bootstrap signing keys."""
    result = bootstrap_keys(
        existing_pem=None if req.generate_new else req.existing_pem
    )
    _put_config("setup_keys_complete", "true")
    return {"status": "ok", **result}


def setup_complete(actor: str) -> dict[str, str]:
    """Mark onboarding complete."""
    # Verify all prerequisite steps are done
    for step_key in [
        "setup_admin_complete",
        "setup_tenant_complete",
        "setup_did_complete",
        "setup_domain_complete",
        "setup_keys_complete",
    ]:
        if _get_config(step_key) != "true":
            raise ValueError(
                f"Cannot complete setup: step '{step_key}' is not done."
            )

    _put_config(ONBOARDING_COMPLETE_KEY, "true", actor=actor)
    return {"status": "ok"}
