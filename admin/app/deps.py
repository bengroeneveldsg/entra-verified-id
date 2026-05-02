"""
AWS client singletons.  Import the objects you need directly from this module.
All clients are created once at import time and reused across requests.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

import boto3
from boto3.resources.base import ServiceResource

from app.settings import settings

if TYPE_CHECKING:
    from mypy_boto3_dynamodb.service_resource import Table  # type: ignore[import]

# ---------------------------------------------------------------------------
# DynamoDB
# ---------------------------------------------------------------------------
dynamodb: ServiceResource = boto3.resource(
    "dynamodb",
    region_name=settings.aws_region,
)

_table_cache: dict[str, "Table"] = {}


def get_table(name: str) -> "Table":
    """Return a cached DynamoDB Table resource for *name*."""
    if name not in _table_cache:
        _table_cache[name] = dynamodb.Table(name)
    return _table_cache[name]


# ---------------------------------------------------------------------------
# S3
# ---------------------------------------------------------------------------
s3_client = boto3.client("s3", region_name=settings.aws_region)

# ---------------------------------------------------------------------------
# Secrets Manager
# ---------------------------------------------------------------------------
secrets_client = boto3.client("secretsmanager", region_name=settings.aws_region)

# ---------------------------------------------------------------------------
# CloudWatch Logs
# ---------------------------------------------------------------------------
logs_client = boto3.client("logs", region_name=settings.aws_region)
