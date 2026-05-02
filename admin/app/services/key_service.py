"""
RSA signing key management.

Replicates the logic previously handled by the KeyBootstrap CloudFormation
custom resource: generate RSA-2048 keys, build JWKS + OIDC discovery docs,
upload to S3, and persist to Secrets Manager.
"""
from __future__ import annotations

import base64
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.x509.oid import NameOID

from app.deps import s3_client, secrets_client
from app.settings import settings

logger = logging.getLogger(__name__)

_WELL_KNOWN_JWKS = ".well-known/jwks.json"
_WELL_KNOWN_OIDC = ".well-known/openid-configuration"
_SECRET_KEY_FIELD = "eamSigningKey"   # Lambda reads "eamSigningKey"
_SECRET_KID_FIELD = "eamKid"          # Lambda reads "eamKid"


# ---------------------------------------------------------------------------
# Key generation
# ---------------------------------------------------------------------------

def generate_rsa_keypair() -> tuple[str, str, str]:
    """
    Generate an RSA-2048 signing key.

    Returns
    -------
    private_pem : str
        PKCS#8 PEM-encoded private key.
    kid : str
        Key ID (random UUID).
    cert_b64 : str
        Base64-encoded DER self-signed certificate (used in JWKS x5c).
    """
    kid = str(uuid.uuid4())

    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    # Self-signed certificate for x5c claim
    subject = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "Entra Verified ID Signing Key"),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc))
        .not_valid_after(
            datetime(2099, 1, 1, tzinfo=timezone.utc)
        )
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )
    cert_b64 = base64.b64encode(
        cert.public_bytes(serialization.Encoding.DER)
    ).decode()

    return private_pem, kid, cert_b64


def _pem_to_jwk(private_pem: str, kid: str, cert_b64: str) -> dict:
    """Convert a PEM private key to a public JWK dict."""
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    private_key = load_pem_private_key(private_pem.encode(), password=None)
    pub = private_key.public_key()
    pub_numbers = pub.public_numbers()
    n_bytes = pub_numbers.n.to_bytes(
        (pub_numbers.n.bit_length() + 7) // 8, "big"
    )
    e_bytes = pub_numbers.e.to_bytes(
        (pub_numbers.e.bit_length() + 7) // 8, "big"
    )

    return {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": kid,
        "n": base64.urlsafe_b64encode(n_bytes).rstrip(b"=").decode(),
        "e": base64.urlsafe_b64encode(e_bytes).rstrip(b"=").decode(),
        "x5c": [cert_b64],
    }


def _build_oidc_config(base_url: str, kid: str) -> dict:
    return {
        "issuer": base_url,
        "jwks_uri": f"{base_url}/{_WELL_KNOWN_JWKS}",
        "response_types_supported": ["id_token"],
        "subject_types_supported": ["public"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "claims_supported": ["sub", "iss", "aud", "exp", "iat"],
    }


def _upload_to_s3(key: str, body: str) -> None:
    s3_client.put_object(
        Bucket=settings.hosting_bucket,
        Key=key,
        Body=body.encode(),
        ContentType="application/json",
        CacheControl="no-store",
    )


def _get_current_secret() -> dict:
    """Read the current app secret from Secrets Manager."""
    try:
        resp = secrets_client.get_secret_value(SecretId=settings.app_secret_name)
        return json.loads(resp.get("SecretString", "{}"))
    except Exception:
        return {}


def _write_secret(data: dict) -> None:
    """Upsert Secrets Manager secret with updated key material."""
    try:
        secrets_client.update_secret(
            SecretId=settings.app_secret_name,
            SecretString=json.dumps(data),
        )
    except secrets_client.exceptions.ResourceNotFoundException:
        secrets_client.create_secret(
            Name=settings.app_secret_name,
            SecretString=json.dumps(data),
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def bootstrap_keys(existing_pem: Optional[str] = None) -> dict:
    """
    Initialise signing keys for the first time.

    If *existing_pem* is provided it is used verbatim (key continuity); otherwise
    a fresh RSA-2048 key is generated.

    Side effects:
      - Uploads ``/.well-known/jwks.json`` and ``/.well-known/openid-configuration``
        to the hosting S3 bucket.
      - Writes key material to Secrets Manager.

    Returns a summary dict.
    """
    if existing_pem:
        # Derive kid + cert from supplied PEM
        kid = str(uuid.uuid4())
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        private_key = load_pem_private_key(existing_pem.encode(), password=None)
        subject = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "Entra Verified ID Signing Key"),
        ])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(private_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc))
            .not_valid_after(datetime(2099, 1, 1, tzinfo=timezone.utc))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(private_key, hashes.SHA256())
        )
        cert_b64 = base64.b64encode(
            cert.public_bytes(serialization.Encoding.DER)
        ).decode()
        private_pem = existing_pem
    else:
        private_pem, kid, cert_b64 = generate_rsa_keypair()

    jwk = _pem_to_jwk(private_pem, kid, cert_b64)
    jwks = {"keys": [jwk]}

    base_url = f"https://{settings.hosting_bucket}"
    oidc_config = _build_oidc_config(base_url, kid)

    _upload_to_s3(_WELL_KNOWN_JWKS, json.dumps(jwks, indent=2))
    _upload_to_s3(_WELL_KNOWN_OIDC, json.dumps(oidc_config, indent=2))

    secret_data = _get_current_secret()
    secret_data.update({
        _SECRET_KEY_FIELD: private_pem,
        _SECRET_KID_FIELD: kid,
        "key_created_at": datetime.now(timezone.utc).isoformat(),
    })
    _write_secret(secret_data)

    # Write kid to SystemConfig for the dashboard
    from app.services.setup_service import _put_config
    _put_config("kid", kid)
    _put_config("key_created_at", datetime.now(timezone.utc).isoformat())

    logger.info("Keys bootstrapped successfully, kid=%s", kid)
    return {"kid": kid, "jwks_url": f"{base_url}/{_WELL_KNOWN_JWKS}"}


def rotate_keys() -> dict:
    """
    Generate a new signing key and add it to the JWKS alongside the old key
    (grace window so existing tokens remain valid).

    Returns a summary dict with the new kid.
    """
    new_pem, new_kid, new_cert_b64 = generate_rsa_keypair()
    new_jwk = _pem_to_jwk(new_pem, new_kid, new_cert_b64)

    # Fetch existing JWKS from S3 to preserve old key(s)
    existing_keys: list[dict] = []
    try:
        obj = s3_client.get_object(
            Bucket=settings.hosting_bucket,
            Key=_WELL_KNOWN_JWKS,
        )
        existing_jwks = json.loads(obj["Body"].read().decode())
        existing_keys = existing_jwks.get("keys", [])
    except Exception:
        logger.warning("Could not read existing JWKS; starting fresh.")

    # Keep the most recent old key for the grace window (max 2 keys total)
    if existing_keys:
        existing_keys = existing_keys[:1]

    merged_keys = [new_jwk] + existing_keys
    jwks = {"keys": merged_keys}

    base_url = f"https://{settings.hosting_bucket}"
    oidc_config = _build_oidc_config(base_url, new_kid)

    _upload_to_s3(_WELL_KNOWN_JWKS, json.dumps(jwks, indent=2))
    _upload_to_s3(_WELL_KNOWN_OIDC, json.dumps(oidc_config, indent=2))

    secret_data = _get_current_secret()
    # Archive old key for grace-period validation (use new field names for consistency)
    secret_data["previous_eamSigningKey"] = secret_data.get(_SECRET_KEY_FIELD, "")
    secret_data["previous_eamKid"] = secret_data.get(_SECRET_KID_FIELD, "")
    secret_data.update({
        _SECRET_KEY_FIELD: new_pem,
        _SECRET_KID_FIELD: new_kid,
        "key_rotated_at": datetime.now(timezone.utc).isoformat(),
    })
    _write_secret(secret_data)

    logger.info("Keys rotated successfully, new_kid=%s", new_kid)
    return {
        "kid": new_kid,
        "jwks_url": f"{base_url}/{_WELL_KNOWN_JWKS}",
        "previous_kid": secret_data.get("previous_eamKid"),
    }
