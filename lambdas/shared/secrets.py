"""
Secrets Manager loader with module-level TTL cache.
Uses the Parameters and Secrets Lambda Extension when available (HTTP on port 2773),
otherwise falls back to direct boto3 calls.
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request

import boto3

logger = logging.getLogger(__name__)

_SECRET_NAME: str = os.environ["SECRET_NAME"]
_CACHE_TTL:   int = 300  # 5 minutes

# Extension caches for us; we keep our own module-level cache as a secondary layer.
_cache:    dict[str, str] | None = None
_cache_at: float = 0.0

_EXTENSION_PORT = "2773"
_EXTENSION_URL  = (
    f"http://localhost:{_EXTENSION_PORT}/secretsmanager/get"
    f"?secretId={urllib.request.quote(_SECRET_NAME, safe='')}"
)


def _fetch_from_extension() -> dict[str, str]:
    req = urllib.request.Request(
        _EXTENSION_URL,
        headers={"X-Aws-Parameters-Secrets-Token": os.environ.get("AWS_SESSION_TOKEN", "")},
    )
    with urllib.request.urlopen(req, timeout=2) as resp:
        body = json.loads(resp.read())
    return json.loads(body["SecretString"])


def _fetch_direct() -> dict[str, str]:
    client = boto3.client("secretsmanager", region_name=os.environ.get("AWS_REGION"))
    resp = client.get_secret_value(SecretId=_SECRET_NAME)
    return json.loads(resp["SecretString"])


def get_secret() -> dict[str, str]:
    """Return the app secret as a dict, using a TTL cache."""
    global _cache, _cache_at
    now = time.time()
    if _cache is not None and (now - _cache_at) < _CACHE_TTL:
        return _cache

    try:
        data = _fetch_from_extension()
    except Exception:
        data = _fetch_direct()

    _cache = data
    _cache_at = now
    return data


def require(key: str) -> str:
    val = get_secret().get(key, "")
    if not val or val == "PENDING_SETUP":
        raise RuntimeError(
            f"Secret not yet initialised (key={key!r}). "
            "Complete the onboarding wizard first."
        )
    return val
