"""
saml_idp/handler.py — SAML 2.0 Identity Provider backed by Entra Verified ID.

Allows Amazon WorkSpaces / Kiro users to authenticate by scanning a
Verified ID QR code instead of entering Entra credentials.

Routes (dispatched by rawPath):
  GET  /api/saml/metadata  → IdP metadata XML
  GET  /api/saml/sso       → parse AuthnRequest (HTTP-Redirect binding), redirect to saml.html
  POST /api/saml/sso       → parse AuthnRequest (HTTP-POST binding), redirect to saml.html
  GET  /api/saml/initiate  → IdP-initiated SSO; creates session, returns sessionId
  GET  /api/saml/complete  → build signed SAML response after VID verification

Security notes:
  - ACS URL is stored in per-app config (never taken from the AuthnRequest).
  - Signing key fetched from Secrets Manager; cached per container lifetime.
  - SHA-256 digest + RSA-PKCS1v15 signature per XML-DSig spec.
  - SAML session TTL: 10 minutes. Completed sessions are marked atomically.
  - lxml exclusive C14N is used verbatim from the original — do not modify.

Config keys used (from SystemConfig):
  entity_id      — SAML IdP entity ID (e.g. https://login.example.com/saml)
  saml_sso_url   — public SSO endpoint URL
  saml_jwks_url  — JWKS endpoint for fetching the signing certificate
  tenant_id      — Entra tenant ID (for Graph API token endpoint)
  frontend_base_url — base URL of the frontend hosting

Secrets keys used (from Secrets Manager):
  eamSigningKey  — RSA-2048 PEM private key (shared with EAM flow)
  clientId       — app client ID (for Graph API group checks)
  clientSecret   — app client secret (for Graph API group checks)

Environment variables:
  STATE_TABLE          — DynamoDB table name (VerifiedIDLoginRequests)
  APP_TABLE            — DynamoDB table for per-app SAML config
  SECRET_NAME          — Secrets Manager secret name
  SYSTEM_CONFIG_TABLE  — DynamoDB SystemConfig table name
  STAGE                — deployment stage (info only)
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
import urllib.parse
import urllib.request
import uuid
import zlib
from typing import Any

import boto3
from boto3.dynamodb.conditions import Attr, Key
from aws_lambda_powertools import Logger

logger = Logger()

# ── AWS singletons ────────────────────────────────────────────────────────────
_region = os.environ.get("AWS_REGION", "ap-southeast-1")
_dynamodb = boto3.resource("dynamodb", region_name=_region)
_secrets_boto = boto3.client("secretsmanager", region_name=_region)

# ── Env-var bootstrap pointers ────────────────────────────────────────────────
_STATE_TABLE: str = os.environ["STATE_TABLE"]
_APP_TABLE: str = os.environ["APP_TABLE"]
_SECRET_NAME: str = os.environ["SECRET_NAME"]
_SYSTEM_CONFIG_TABLE: str = os.environ["SYSTEM_CONFIG_TABLE"]

# ── TTL ───────────────────────────────────────────────────────────────────────
_TTL_SECONDS: int = 600

# ── Per-app SAML fallback defaults ───────────────────────────────────────────
_DEFAULT_APP = {
    "spEntityId": "urn:amazon:webservices",
    "acsUrl": "https://signin.aws.amazon.com/saml",
    "relayState": "",
    "roleArn": "",
    "providerArn": "",
    "sessionName": "VerifiedIDSession",
    "sessionDuration": "43200",
    "displayName": "Verified ID",
}

# ── Module-level caches ───────────────────────────────────────────────────────
_secrets_cache: dict[str, str] | None = None
_secrets_cache_at: float = 0.0
_SECRETS_TTL: int = 300

_config_cache: dict[str, str] | None = None
_config_cache_at: float = 0.0
_CONFIG_TTL: int = 300

_app_config_cache: dict[str, dict] = {}
_cached_cert_b64: str | None = None
_cached_graph_token: dict | None = None  # {token, expires_at}

_EXTENSION_PORT = "2773"


# ── Inline secrets helper ─────────────────────────────────────────────────────

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


# ── Per-app config loader ─────────────────────────────────────────────────────

def _get_app_config(app_id: str) -> dict:
    """Fetch per-app SAML config from APP_TABLE (module-level cached)."""
    if app_id in _app_config_cache:
        return _app_config_cache[app_id]
    try:
        resp = _dynamodb.Table(_APP_TABLE).get_item(Key={"appId": app_id})
        item = resp.get("Item")
        if item:
            cfg = {k: v for k, v in item.items() if k != "appId"}
            _app_config_cache[app_id] = cfg
            logger.info("Loaded app config", extra={"appId": app_id})
            return cfg
    except Exception as exc:
        logger.warning(
            "Could not load app config",
            extra={"appId": app_id, "error": str(exc)},
        )
    return dict(_DEFAULT_APP)


# ── Graph API group access check ──────────────────────────────────────────────

def _get_graph_token(client_id: str, client_secret: str, tenant_id: str) -> str:
    """Get a cached Microsoft Graph API access token via client credentials."""
    global _cached_graph_token
    now = int(time.time())
    if _cached_graph_token and _cached_graph_token["expires_at"] > now + 60:
        return _cached_graph_token["token"]

    url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "https://graph.microsoft.com/.default",
        }
    ).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
    token = data["access_token"]
    _cached_graph_token = {
        "token": token,
        "expires_at": now + int(data.get("expires_in", 3600)),
    }
    logger.info(
        "Graph API token acquired",
        extra={"expiresIn": data.get("expires_in", 3600)},
    )
    return token


def _check_group_access(
    user_email: str,
    allowed_group_ids: list[str],
    client_id: str,
    client_secret: str,
    tenant_id: str,
) -> bool:
    """Return True if user is a member of at least one allowed group."""
    if not allowed_group_ids:
        return True  # no restriction — allow everyone

    try:
        token = _get_graph_token(client_id, client_secret, tenant_id)
        url = (
            f"https://graph.microsoft.com/v1.0/users/"
            f"{urllib.parse.quote(user_email)}/checkMemberObjects"
        )
        body = json.dumps({"ids": allowed_group_ids}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            result = json.loads(r.read()).get("value", [])
        matched = set(result) & set(allowed_group_ids)
        logger.info(
            "Group check",
            extra={
                "userPrefix": user_email[:20],
                "matched": list(matched),
                "allowed": allowed_group_ids,
            },
        )
        return bool(matched)
    except Exception as exc:
        logger.error(
            "Group membership check failed",
            extra={"userPrefix": user_email[:20], "error": str(exc)},
        )
        return False  # fail closed


# ── JWKS cert helper ──────────────────────────────────────────────────────────

def _get_cert_b64() -> str:
    """Read X.509 cert (x5c) from S3 hosting bucket — avoids HTTP round-trip.

    Lambdas have IAM read access to the hosting bucket so this is faster
    and more reliable than fetching via the public CloudFront URL.
    """
    global _cached_cert_b64
    if _cached_cert_b64 is None:
        hosting_bucket = os.environ.get("HOSTING_BUCKET", "")
        if hosting_bucket:
            resp = boto3.client("s3", region_name=_region).get_object(
                Bucket=hosting_bucket, Key=".well-known/jwks.json"
            )
            jwks = json.loads(resp["Body"].read())
        else:
            # Fallback: fetch via HTTPS (requires internet egress)
            jwks_url = _require_config("saml_jwks_url")
            with urllib.request.urlopen(jwks_url, timeout=10) as r:
                jwks = json.loads(r.read())
        _cached_cert_b64 = jwks["keys"][0]["x5c"][0]
        logger.info("JWKS cert loaded and cached")
    return _cached_cert_b64


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _cors_headers() -> dict[str, str]:
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    }


def _json_response(status_code: int, body: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {**_cors_headers(), "Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _xml_response(xml: str) -> dict[str, Any]:
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/xml; charset=utf-8"},
        "body": xml,
    }


def _redirect(location: str) -> dict[str, Any]:
    return {
        "statusCode": 302,
        "headers": {"Location": location},
        "body": "",
    }


# ── SAML XML builders ─────────────────────────────────────────────────────────

def _now_and_exp() -> tuple[str, str]:
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    return (
        now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        (now + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )


def _build_assertion(
    assertion_id: str,
    authn_req_id: str,
    name_id: str,
    attrs: dict[str, str],
    now_iso: str,
    exp_iso: str,
    entity_id: str,
    sp_entity_id: str = "urn:amazon:webservices",
    acs_url: str = "https://signin.aws.amazon.com/saml",
) -> str:
    """Single-line assertion XML with explicit namespaces for simplified C14N."""
    # Use plain AttributeValue with no inline type declarations.
    # AWS SAML does not require xsi:type; stripping it eliminates the
    # xmlns:xs / xmlns:xsi ordering ambiguity that breaks exclusive C14N
    # digest matching during signature verification.
    attr_xml = "".join(
        f'<saml:Attribute Name="{k}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri">'
        f"<saml:AttributeValue>{v}</saml:AttributeValue>"
        f"</saml:Attribute>"
        for k, v in attrs.items()
        if v
    )
    return (
        # xmlns:saml MUST be declared here. Exclusive C14N is applied to the
        # assertion as a document SUBSET — the Response parent is outside the subset,
        # so xmlns:saml is NOT inherited. C14N adds it to the assertion root,
        # therefore our hashed bytes must include it.
        f'<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{assertion_id}" IssueInstant="{now_iso}" Version="2.0">'
        f"<saml:Issuer>{entity_id}</saml:Issuer>"
        f"<saml:Subject>"
        f'<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">{name_id}</saml:NameID>'
        f'<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">'
        f'<saml:SubjectConfirmationData{" InResponseTo=" + chr(34) + authn_req_id + chr(34) if authn_req_id else ""} '
        f'NotOnOrAfter="{exp_iso}" Recipient="{acs_url}">'
        f"</saml:SubjectConfirmationData>"
        f"</saml:SubjectConfirmation>"
        f"</saml:Subject>"
        f'<saml:Conditions NotBefore="{now_iso}" NotOnOrAfter="{exp_iso}">'
        f"<saml:AudienceRestriction><saml:Audience>{sp_entity_id}</saml:Audience></saml:AudienceRestriction>"
        f"</saml:Conditions>"
        f'<saml:AuthnStatement AuthnInstant="{now_iso}">'
        f"<saml:AuthnContext><saml:AuthnContextClassRef>"
        f"urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"
        f"</saml:AuthnContextClassRef></saml:AuthnContext>"
        f"</saml:AuthnStatement>"
        f"<saml:AttributeStatement>{attr_xml}</saml:AttributeStatement>"
        f"</saml:Assertion>"
    )


def _sign_assertion(
    assertion_xml: str,
    private_key_pem: str,
    cert_b64: str,
    assertion_id: str,
    entity_id: str,
) -> str:
    """Enveloped XML signature using lxml for correct exclusive C14N (RFC 4051)."""
    from lxml import etree
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding as asym_padding

    key = serialization.load_pem_private_key(private_key_pem.encode(), password=None)

    # Parse assertion; compute exclusive C14N — this is exactly what AWS verifies
    assertion_elem = etree.fromstring(assertion_xml.encode("utf-8"))
    assertion_c14n = etree.tostring(
        assertion_elem, method="c14n", exclusive=True, with_comments=False
    )
    digest_b64 = base64.b64encode(hashlib.sha256(assertion_c14n).digest()).decode()

    # Build SignedInfo element and compute its exclusive C14N for signing
    signed_info_elem = etree.fromstring(
        (
            f'<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">'
            f'<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>'
            f'<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>'
            f'<ds:Reference URI="#{assertion_id}">'
            f"<ds:Transforms>"
            f'<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>'
            f'<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>'
            f"</ds:Transforms>"
            f'<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>'
            f"<ds:DigestValue>{digest_b64}</ds:DigestValue>"
            f"</ds:Reference>"
            f"</ds:SignedInfo>"
        ).encode("utf-8")
    )
    signed_info_c14n = etree.tostring(
        signed_info_elem, method="c14n", exclusive=True, with_comments=False
    )

    # Sign the C14N SignedInfo bytes
    sig_b64 = base64.b64encode(
        key.sign(signed_info_c14n, asym_padding.PKCS1v15(), hashes.SHA256())
    ).decode()

    # Serialise SignedInfo back to string for embedding in the Signature element
    signed_info_str = etree.tostring(signed_info_elem, encoding="unicode")

    signature = (
        f'<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">'
        f"{signed_info_str}"
        f"<ds:SignatureValue>{sig_b64}</ds:SignatureValue>"
        f"<ds:KeyInfo><ds:X509Data>"
        f"<ds:X509Certificate>{cert_b64}</ds:X509Certificate>"
        f"</ds:X509Data></ds:KeyInfo>"
        f"</ds:Signature>"
    )

    # Insert signature immediately after <saml:Issuer>...</saml:Issuer>
    return assertion_xml.replace(
        f"<saml:Issuer>{entity_id}</saml:Issuer>",
        f"<saml:Issuer>{entity_id}</saml:Issuer>{signature}",
        1,
    )


def _build_response(
    response_id: str,
    authn_req_id: str,
    signed_assertion: str,
    now_iso: str,
    entity_id: str,
    acs_url: str = "https://signin.aws.amazon.com/saml",
) -> str:
    return (
        f'<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" '
        f'xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" '
        f'ID="{response_id}"'
        f'{" InResponseTo=" + chr(34) + authn_req_id + chr(34) if authn_req_id else ""} '
        f'Version="2.0" IssueInstant="{now_iso}" Destination="{acs_url}">'
        f"<saml:Issuer>{entity_id}</saml:Issuer>"
        f"<samlp:Status><samlp:StatusCode "
        f'Value="urn:oasis:names:tc:SAML:2.0:status:Success">'
        f"</samlp:StatusCode></samlp:Status>"
        f"{signed_assertion}"
        f"</samlp:Response>"
    )


# ── Route handlers ────────────────────────────────────────────────────────────

def _handle_metadata() -> dict[str, Any]:
    """Return IdP metadata XML."""
    try:
        cert_b64 = _get_cert_b64()
        entity_id = _require_config("entity_id")
        sso_url = _require_config("saml_sso_url")
    except Exception:
        logger.exception("Failed to load metadata material")
        return _json_response(503, {"error": "Could not load IdP certificate"})

    xml = (
        '<?xml version="1.0"?>\n'
        f'<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="{entity_id}">\n'
        '  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" '
        'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">\n'
        '    <md:KeyDescriptor use="signing">\n'
        '      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">\n'
        "        <ds:X509Data>"
        f"<ds:X509Certificate>{cert_b64}</ds:X509Certificate>"
        "</ds:X509Data>\n"
        "      </ds:KeyInfo>\n"
        "    </md:KeyDescriptor>\n"
        "    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>\n"
        f'    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="{sso_url}"/>\n'
        f'    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="{sso_url}"/>\n'
        "  </md:IDPSSODescriptor>\n"
        "</md:EntityDescriptor>"
    )
    return _xml_response(xml)


def _parse_authn_request(event: dict[str, Any]) -> tuple[str, str]:
    """Extract SAMLRequest and RelayState from GET query string or POST form body."""
    method = (
        event.get("requestContext", {}).get("http", {}).get("method", "GET").upper()
    )
    qs: dict[str, str] = event.get("queryStringParameters") or {}
    relay_state = qs.get("RelayState", "")
    saml_request_encoded: str = ""

    if method == "POST":
        raw_body: str = event.get("body") or ""
        is_b64 = event.get("isBase64Encoded", False)
        if is_b64:
            raw_body = base64.b64decode(raw_body).decode("utf-8", errors="replace")
        form: dict[str, str] = dict(urllib.parse.parse_qsl(raw_body))
        saml_request_encoded = form.get("SAMLRequest", "")
        relay_state = form.get("RelayState", relay_state)
    else:
        saml_request_encoded = qs.get("SAMLRequest", "")

    authn_req_id = f"_authn_{uuid.uuid4().hex}"  # fallback

    if saml_request_encoded:
        try:
            decoded_bytes = base64.b64decode(saml_request_encoded)
            # Try deflate first (HTTP-Redirect), then plain (HTTP-POST)
            try:
                xml_str = zlib.decompress(decoded_bytes, -zlib.MAX_WBITS).decode("utf-8")
            except zlib.error:
                xml_str = decoded_bytes.decode("utf-8")

            match = re.search(r'\bID="([^"]+)"', xml_str)
            if match:
                authn_req_id = match.group(1)
                logger.info("Parsed AuthnRequest ID", extra={"authnReqId": authn_req_id[:40]})
        except Exception:
            logger.warning(
                "Failed to decode SAMLRequest; using generated ID",
                extra={"authnReqId": authn_req_id},
            )

    return authn_req_id, relay_state


def _handle_sso(event: dict[str, Any]) -> dict[str, Any]:
    """Handle GET|POST /api/saml/sso."""
    authn_req_id, relay_state = _parse_authn_request(event)
    qs = event.get("queryStringParameters") or {}
    app_id = qs.get("app", "kiro").strip()
    cfg = _get_app_config(app_id)

    try:
        frontend_base_url = _require_config("frontend_base_url").rstrip("/")
    except RuntimeError as exc:
        logger.error("Config not available", error=str(exc))
        return _json_response(503, {"error": "Service not initialised"})

    session_id = str(uuid.uuid4())
    now = int(time.time())

    table = _dynamodb.Table(_STATE_TABLE)
    try:
        table.put_item(
            Item={
                "requestId": session_id,
                "type": "saml_session",
                "status": "pending",
                "app_id": app_id,
                "authn_request_id": authn_req_id,
                "acs_url": cfg.get("acsUrl", _DEFAULT_APP["acsUrl"]),
                "relay_state": relay_state or cfg.get("relayState", ""),
                "sp_entity_id": cfg.get("spEntityId", _DEFAULT_APP["spEntityId"]),
                "role_arn": cfg.get("roleArn", ""),
                "provider_arn": cfg.get("providerArn", ""),
                "session_name": cfg.get("sessionName", _DEFAULT_APP["sessionName"]),
                "session_duration": cfg.get(
                    "sessionDuration", _DEFAULT_APP["sessionDuration"]
                ),
                "allowed_group_ids": cfg.get("allowedGroupIds", []),
                "createdAt": now,
                "ttl": now + _TTL_SECONDS,
            }
        )
    except Exception:
        logger.exception("Failed to create SAML session", extra={"sessionId": session_id})
        return _json_response(500, {"error": "Internal server error"})

    logger.info(
        "SAML session created",
        extra={"sessionId": session_id, "authnReqId": authn_req_id[:40]},
    )
    redirect_url = f"{frontend_base_url}/saml.html?session={session_id}"
    return _redirect(redirect_url)


def _handle_complete(event: dict[str, Any]) -> dict[str, Any]:
    """Handle GET /api/saml/complete?session=<id>&vid=<id>."""
    qs: dict[str, str] = event.get("queryStringParameters") or {}
    session_id = qs.get("session", "").strip()
    vid_id = qs.get("vid", "").strip()

    if not session_id or not vid_id:
        return _json_response(400, {"error": "Missing session or vid parameter"})

    table = _dynamodb.Table(_STATE_TABLE)

    # ── 1. Load SAML session ──────────────────────────────────────────────────
    try:
        resp = table.get_item(Key={"requestId": session_id})
    except Exception:
        logger.exception("DynamoDB error fetching session", extra={"sessionId": session_id})
        return _json_response(500, {"error": "Internal server error"})

    session = resp.get("Item")
    if session is None or session.get("type") != "saml_session":
        return _json_response(404, {"error": "Session not found"})

    if int(session.get("ttl", 0)) < int(time.time()):
        return _json_response(404, {"error": "Session expired"})

    if session.get("status") == "completed":
        return _json_response(409, {"error": "Session already completed"})

    # ── 2. Load VID record ────────────────────────────────────────────────────
    try:
        vid_resp = table.get_item(Key={"requestId": vid_id})
    except Exception:
        logger.exception("DynamoDB error fetching VID record", extra={"vidId": vid_id})
        return _json_response(500, {"error": "Internal server error"})

    vid_item = vid_resp.get("Item")
    if vid_item is None:
        return _json_response(404, {"error": "VID request not found"})

    vid_status = vid_item.get("status", "pending")
    if vid_status not in ("claimed", "success"):
        return _json_response(202, {"status": "pending"})

    # ── 3. Extract claims ─────────────────────────────────────────────────────
    claims: dict[str, Any] = vid_item.get("claims", {})
    raw_id: str = (
        claims.get("mail")
        or claims.get("userPrincipalName")
        or claims.get("email")
        or "unknown@unknown"
    )
    name_id: str = raw_id

    # ── Group access check ────────────────────────────────────────────────────
    allowed_group_ids: list[str] = session.get("allowed_group_ids", [])
    if allowed_group_ids:
        try:
            secret_for_check = _get_secret()
            tenant_id = _require_config("tenant_id")
            if not _check_group_access(
                name_id,
                allowed_group_ids,
                secret_for_check["clientId"],
                secret_for_check["clientSecret"],
                tenant_id,
            ):
                logger.warning(
                    "Access denied: not in allowed groups",
                    extra={
                        "nameIdPrefix": name_id[:30],
                        "appId": session.get("app_id", "?"),
                    },
                )
                return _json_response(
                    403,
                    {
                        "error": "access_denied",
                        "message": (
                            "You do not have access to this application. "
                            "Contact your administrator to request access."
                        ),
                    },
                )
        except Exception:
            logger.exception("Group check failed — denying access")
            return _json_response(503, {"error": "Group check unavailable"})

    sess_acs_url = session.get("acs_url", _DEFAULT_APP["acsUrl"])
    sess_sp_entity_id = session.get("sp_entity_id", _DEFAULT_APP["spEntityId"])
    sess_role_arn = session.get("role_arn", "")
    sess_provider_arn = session.get("provider_arn", "")
    sess_session_name = session.get("session_name", _DEFAULT_APP["sessionName"])
    sess_duration = session.get("session_duration", _DEFAULT_APP["sessionDuration"])

    saml_attrs = {
        "https://aws.amazon.com/SAML/Attributes/RoleSessionName": sess_session_name,
        "https://aws.amazon.com/SAML/Attributes/Role": (
            f"{sess_role_arn},{sess_provider_arn}"
        ),
        "https://aws.amazon.com/SAML/Attributes/SessionDuration": sess_duration,
    }

    logger.info(
        "Building SAML assertion",
        extra={
            "sessionId": session_id,
            "nameIdPrefix": name_id[:6] if name_id else "?",
        },
    )

    # ── 4. Build and sign the SAML Response ───────────────────────────────────
    try:
        entity_id = _require_config("entity_id")
        private_key_pem: str = _require_secret("eamSigningKey")
        cert_b64 = _get_cert_b64()
    except Exception:
        logger.exception("Failed to load signing material")
        return _json_response(503, {"error": "Signing material unavailable"})

    try:
        assertion_id = f"_a{uuid.uuid4().hex}"
        response_id = f"_r{uuid.uuid4().hex}"
        authn_req_id = session.get("authn_request_id", f"_authn_{uuid.uuid4().hex}")
        now_iso, exp_iso = _now_and_exp()

        assertion_xml = _build_assertion(
            assertion_id,
            authn_req_id,
            name_id,
            saml_attrs,
            now_iso,
            exp_iso,
            entity_id,
            sp_entity_id=sess_sp_entity_id,
            acs_url=sess_acs_url,
        )
        signed_assertion = _sign_assertion(
            assertion_xml, private_key_pem, cert_b64, assertion_id, entity_id
        )
        response_xml = _build_response(
            response_id,
            authn_req_id,
            signed_assertion,
            now_iso,
            entity_id,
            acs_url=sess_acs_url,
        )
        saml_response_b64 = base64.b64encode(response_xml.encode("utf-8")).decode()
    except Exception:
        logger.exception(
            "Failed to build SAML response", extra={"sessionId": session_id}
        )
        return _json_response(500, {"error": "Failed to build SAML response"})

    # ── 5. Mark session as completed (atomic, best-effort) ────────────────────
    try:
        table.update_item(
            Key={"requestId": session_id},
            UpdateExpression="SET #st = :completed, completedAt = :now",
            ConditionExpression=Attr("status").eq("pending"),
            ExpressionAttributeNames={"#st": "status"},
            ExpressionAttributeValues={
                ":completed": "completed",
                ":now": int(time.time()),
            },
        )
    except _dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.info(
            "Session already marked completed (race)",
            extra={"sessionId": session_id},
        )
    except Exception:
        logger.warning(
            "Failed to mark session completed", extra={"sessionId": session_id}
        )

    return _json_response(
        200,
        {
            "samlResponse": saml_response_b64,
            "acsUrl": sess_acs_url,
            "relayState": session.get("relay_state", ""),
        },
    )


def _handle_initiate(event: dict[str, Any]) -> dict[str, Any]:
    """IdP-initiated SSO. Creates a session and returns sessionId."""
    qs = event.get("queryStringParameters") or {}
    app_id = qs.get("app", "").strip() or "kiro"
    cfg = _get_app_config(app_id)

    session_id = str(uuid.uuid4())
    now = int(time.time())
    _dynamodb.Table(_STATE_TABLE).put_item(
        Item={
            "requestId": session_id,
            "type": "saml_session",
            "status": "pending",
            "app_id": app_id,
            "authn_request_id": "",
            "acs_url": cfg.get("acsUrl", _DEFAULT_APP["acsUrl"]),
            "relay_state": cfg.get("relayState", ""),
            "sp_entity_id": cfg.get("spEntityId", _DEFAULT_APP["spEntityId"]),
            "role_arn": cfg.get("roleArn", ""),
            "provider_arn": cfg.get("providerArn", ""),
            "session_name": cfg.get("sessionName", _DEFAULT_APP["sessionName"]),
            "session_duration": cfg.get("sessionDuration", _DEFAULT_APP["sessionDuration"]),
            "createdAt": now,
            "ttl": now + _TTL_SECONDS,
        }
    )
    display_name = cfg.get("displayName", app_id)
    logger.info("IdP-initiated SAML session created", extra={"sessionId": session_id, "app": app_id})
    return _json_response(200, {"sessionId": session_id, "displayName": display_name})


# ── Main dispatcher ───────────────────────────────────────────────────────────

@logger.inject_lambda_context
def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Route API Gateway HTTP API events to the correct SAML handler."""
    http_ctx = event.get("requestContext", {}).get("http", {})
    if http_ctx.get("method") == "OPTIONS":
        return {"statusCode": 204, "headers": _cors_headers(), "body": ""}

    raw_path: str = event.get("rawPath", "")
    method: str = http_ctx.get("method", "GET").upper()

    logger.info("SAML IdP request", extra={"method": method, "path": raw_path})

    if raw_path == "/api/saml/metadata" and method == "GET":
        return _handle_metadata()

    if raw_path == "/api/saml/sso" and method in ("GET", "POST"):
        return _handle_sso(event)

    if raw_path == "/api/saml/initiate" and method == "GET":
        return _handle_initiate(event)

    if raw_path == "/api/saml/complete" and method == "GET":
        return _handle_complete(event)

    if raw_path == "/api/saml/apps" and method == "GET":
        return _handle_apps()

    return _json_response(404, {"error": "Not found"})


def _handle_apps() -> dict[str, Any]:
    """GET /api/saml/apps — public endpoint returning enabled SAML app list for the landing page."""
    try:
        table = _dynamodb.Table(_APP_TABLE)
        resp = table.scan(
            ProjectionExpression="appId, displayName, description, enabled",
        )
        apps = [
            {
                "id":          item["appId"],
                "displayName": item.get("displayName", item["appId"]),
                "description": item.get("description", ""),
            }
            for item in resp.get("Items", [])
            if item.get("enabled", True) is not False
        ]
        apps.sort(key=lambda a: a["displayName"])
    except Exception:
        logger.exception("Failed to list SAML apps")
        apps = []

    return {
        "statusCode": 200,
        "headers": {**_cors_headers(), "Content-Type": "application/json"},
        "body": json.dumps({"apps": apps}),
    }
