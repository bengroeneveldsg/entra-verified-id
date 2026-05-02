"""Audit log and runtime CloudWatch Logs routes."""
from __future__ import annotations

import time
from typing import Optional

from decimal import Decimal
from boto3.dynamodb.conditions import Attr, Key
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth import current_user
from app.deps import get_table, logs_client
from app.settings import settings

router = APIRouter(prefix="/audit", tags=["audit"])


def _serialise(obj: object) -> object:
    """Recursively convert DynamoDB Decimal types to int/float for JSON."""
    if isinstance(obj, Decimal):
        return int(obj) if obj == int(obj) else float(obj)
    if isinstance(obj, dict):
        return {k: _serialise(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_serialise(v) for v in obj]
    return obj


@router.get("/")
async def list_audit_log(
    actor: Optional[str] = Query(default=None),
    from_ts: Optional[str] = Query(default=None, description="ISO 8601 start timestamp"),
    to_ts: Optional[str] = Query(default=None, description="ISO 8601 end timestamp"),
    limit: int = Query(default=200, ge=1, le=1000),
    user: dict = Depends(current_user),
) -> list[dict]:
    table = get_table(settings.audit_log_table)

    # Query on pk="audit" — efficient; avoids full-table scan
    key_cond = Key("pk").eq("audit")
    filter_parts = []
    if actor:
        filter_parts.append(Attr("actor").eq(actor))
    if from_ts:
        filter_parts.append(Attr("timestamp").gte(from_ts))
    if to_ts:
        filter_parts.append(Attr("timestamp").lte(to_ts))

    query_kwargs: dict = {
        "KeyConditionExpression": key_cond,
        "ScanIndexForward": False,   # newest first (descending sk)
        "Limit": limit,
    }
    if filter_parts:
        combined = filter_parts[0]
        for part in filter_parts[1:]:
            combined = combined & part
        query_kwargs["FilterExpression"] = combined

    resp = table.query(**query_kwargs)
    items = resp.get("Items", [])
    return [_serialise(item) for item in items]


@router.get("/runtime")
async def get_runtime_logs(
    log_group: Optional[str] = Query(default=None),
    minutes: int = Query(default=60, ge=1, le=1440),
    user: dict = Depends(current_user),
) -> dict:
    """
    Run a CloudWatch Logs Insights query for recent log entries.
    Uses the ECS task log group if none specified.
    """
    if not log_group:
        stage = settings.stage
        log_group = f"/entra-vid/admin-{stage}"

    end_time = int(time.time())
    start_time = end_time - minutes * 60

    # Keep only meaningful events — real API requests and structured app logs.
    # Filter out: health checks, internal probes, uvicorn lifecycle messages.
    query_string = (
        "fields @timestamp, @message "
        '| filter @message not like "/health" '
        '| filter @message not like "127.0.0.1" '
        '| filter @message not like "Started server" '
        '| filter @message not like "Waiting for application" '
        '| filter @message not like "Application startup" '
        '| filter @message not like "Application shutdown" '
        '| filter @message not like "Finished server" '
        '| filter @message not like "Shutting down" '
        '| filter @message not like "Uvicorn running" '
        "| sort @timestamp desc "
        "| limit 200"
    )

    try:
        start_resp = logs_client.start_query(
            logGroupName=log_group,
            startTime=start_time,
            endTime=end_time,
            queryString=query_string,
        )
        query_id = start_resp["queryId"]

        # Poll until complete (max 30s)
        for _ in range(30):
            time.sleep(1)
            result = logs_client.get_query_results(queryId=query_id)
            if result["status"] in ("Complete", "Failed", "Cancelled"):
                break

        if result["status"] != "Complete":
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail=f"CloudWatch query did not complete in time: {result['status']}",
            )

        import json as _json
        import re as _re

        # Uvicorn request log pattern: INFO:     1.2.3.4:port - "METHOD /path HTTP/1.1" STATUS msg
        _uvicorn_re = _re.compile(
            r'^(?P<level>\w+):\s+(?P<client>\S+) - "(?P<method>\w+) (?P<path>\S+) HTTP/[\d.]+" (?P<status>\d+)'
        )

        def _parse(raw: str) -> dict:
            """Try to parse a log line into structured fields."""
            raw = raw.strip()
            # Structured JSON (Powertools)
            if raw.startswith("{"):
                try:
                    d = _json.loads(raw)
                    return {
                        "type": "app",
                        "level": d.get("level", "INFO"),
                        "message": d.get("message", ""),
                        "location": d.get("location", ""),
                        "details": {k: v for k, v in d.items()
                                    if k not in ("level", "message", "location", "timestamp",
                                                 "service", "cold_start", "function_name",
                                                 "function_memory_size", "function_arn",
                                                 "function_request_id", "xray_trace_id")},
                    }
                except Exception:
                    pass
            # Uvicorn request log
            m = _uvicorn_re.match(raw)
            if m:
                status_code = int(m.group("status"))
                return {
                    "type": "request",
                    "level": "ERROR" if status_code >= 500 else "WARNING" if status_code >= 400 else "INFO",
                    "method": m.group("method"),
                    "path": m.group("path"),
                    "status": status_code,
                    "client": m.group("client"),
                    "message": f'{m.group("method")} {m.group("path")} → {status_code}',
                }
            # Plain text
            return {"type": "raw", "level": "INFO", "message": raw[:300]}

        rows = []
        for row in result.get("results", []):
            entry = {field["field"]: field["value"] for field in row}
            parsed = _parse(entry.get("@message", ""))
            parsed["timestamp"] = entry.get("@timestamp", "")
            rows.append(parsed)

        return {"log_group": log_group, "rows": rows, "statistics": result.get("statistics", {})}

    except logs_client.exceptions.ResourceNotFoundException:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Log group '{log_group}' not found",
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"CloudWatch error: {exc}",
        )
