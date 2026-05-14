"""
SystemConfig loader with module-level TTL cache.
Reads all config keys from DynamoDB (pk="system") and returns a dict.
Falls back gracefully when onboarding is not yet complete.
"""
from __future__ import annotations

import os
import time
import json
import logging
import urllib.request

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger(__name__)

_TABLE_NAME: str = os.environ["SYSTEM_CONFIG_TABLE"]
_CACHE_TTL: int = 300  # 5 minutes

_dynamodb = boto3.resource("dynamodb", region_name=os.environ.get("AWS_REGION"))
_table    = _dynamodb.Table(_TABLE_NAME)

_cache: dict[str, str] | None = None
_cache_at: float = 0.0


def get_config() -> dict[str, str]:
    """Return all system config as a flat dict, using a TTL cache."""
    global _cache, _cache_at
    now = time.time()
    if _cache is not None and (now - _cache_at) < _CACHE_TTL:
        return _cache

    try:
        resp = _table.query(
            KeyConditionExpression=Key("pk").eq("system"),
        )
        result: dict[str, str] = {}
        for item in resp.get("Items", []):
            result[item["sk"]] = item.get("value", "")
        _cache = result
        _cache_at = now
        return result
    except Exception:
        logger.exception("Failed to load SystemConfig from DynamoDB")
        return _cache or {}


def require(key: str) -> str:
    """Get a required config value; raise if not found or still PENDING_SETUP."""
    val = get_config().get(key, "")
    if not val or val == "PENDING_SETUP":
        raise RuntimeError(
            f"System configuration not initialised (key={key!r}). "
            "Complete the onboarding wizard first."
        )
    return val
