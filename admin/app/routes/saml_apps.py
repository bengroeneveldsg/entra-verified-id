"""SAML application CRUD routes."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response, status

from app.auth import current_user, write_audit_log
from app.deps import get_table, secrets_client
from app.models.saml_apps import CreateSamlAppRequest, SamlApp, UpdateSamlAppRequest
from app.settings import settings

router = APIRouter(prefix="/saml-apps", tags=["saml-apps"])

# ---------------------------------------------------------------------------
# Microsoft Graph API helpers (group search / resolve)
# ---------------------------------------------------------------------------

_graph_token_cache: dict = {}


def _get_graph_credentials() -> tuple[str, str, str]:
    """Return (client_id, client_secret, tenant_id) or raise HTTP 503."""
    try:
        resp = secrets_client.get_secret_value(SecretId=settings.app_secret_name)
        secret_data = json.loads(resp["SecretString"])
        client_id = secret_data.get("clientId", "")
        client_secret = secret_data.get("clientSecret", "")
    except Exception as exc:
        raise HTTPException(status_code=503, detail="App credentials not yet configured") from exc

    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="App credentials not yet configured")

    config_table = get_table(settings.system_config_table)
    item = config_table.get_item(Key={"pk": "system", "sk": "tenant_id"}).get("Item")
    tenant_id = (item or {}).get("value", "")
    if not tenant_id:
        raise HTTPException(status_code=503, detail="Tenant not yet configured")

    return client_id, client_secret, tenant_id


def _get_graph_token(client_id: str, client_secret: str, tenant_id: str) -> str:
    """Return a cached client-credentials token for Microsoft Graph."""
    now = int(time.time())
    if _graph_token_cache.get("expires_at", 0) > now + 60:
        return _graph_token_cache["token"]
    url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": "https://graph.microsoft.com/.default",
    }).encode()
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
    _graph_token_cache["token"] = data["access_token"]
    _graph_token_cache["expires_at"] = now + int(data.get("expires_in", 3600))
    return _graph_token_cache["token"]


def _get_app_or_404(app_id: str) -> dict[str, Any]:
    table = get_table(settings.app_table)
    resp = table.get_item(Key={"appId": app_id})
    item = resp.get("Item")
    if not item:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"SAML app '{app_id}' not found",
        )
    return item


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/groups/search")
async def search_groups(
    q: Annotated[str, Query(min_length=2, max_length=100)],
    user: dict = Depends(current_user),
) -> list[dict]:
    """Search Entra security groups by display name via Microsoft Graph."""
    client_id, client_secret, tenant_id = _get_graph_credentials()
    try:
        token = _get_graph_token(client_id, client_secret, tenant_id)
        params = urllib.parse.urlencode({
            "$search": f'"displayName:{q}"',
            "$select": "id,displayName,description",
            "$top": "20",
        })
        req = urllib.request.Request(
            f"https://graph.microsoft.com/v1.0/groups?{params}",
            headers={"Authorization": f"Bearer {token}", "ConsistencyLevel": "eventual"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        return [
            {"id": g["id"], "displayName": g.get("displayName", ""), "description": g.get("description") or ""}
            for g in data.get("value", [])
        ]
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        if exc.code == 403:
            raise HTTPException(status_code=503, detail="GroupMember.Read.All permission not granted on the app registration") from exc
        raise HTTPException(status_code=502, detail=f"Graph API error {exc.code}: {body[:200]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Group search failed: {exc}") from exc


@router.post("/groups/resolve")
async def resolve_groups(
    ids: Annotated[list[str], Body()],
    user: dict = Depends(current_user),
) -> list[dict]:
    """Resolve a list of Entra group Object IDs to display names via Microsoft Graph."""
    if not ids:
        return []
    client_id, client_secret, tenant_id = _get_graph_credentials()
    try:
        token = _get_graph_token(client_id, client_secret, tenant_id)
        body = json.dumps({"ids": ids[:100], "types": ["group"]}).encode()
        req = urllib.request.Request(
            "https://graph.microsoft.com/v1.0/directoryObjects/getByIds",
            data=body,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        return [
            {"id": g["id"], "displayName": g.get("displayName", ""), "description": g.get("description") or ""}
            for g in data.get("value", [])
        ]
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode(errors="replace")
        raise HTTPException(status_code=502, detail=f"Graph API error {exc.code}: {body_text[:200]}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Group resolve failed: {exc}") from exc


@router.get("/")
async def list_apps(
    user: dict = Depends(current_user),
) -> list[dict]:
    table = get_table(settings.app_table)
    resp = table.scan()
    items = resp.get("Items", [])
    # Handle pagination
    while "LastEvaluatedKey" in resp:
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        items.extend(resp.get("Items", []))
    return sorted(items, key=lambda x: x.get("displayName", "").lower())


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_app(
    req: CreateSamlAppRequest,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    table = get_table(settings.app_table)
    now = datetime.now(timezone.utc).isoformat()
    app_id = str(uuid.uuid4())

    # model_dump serialises nested SamlAttribute / NameIdConfig to plain dicts,
    # and exclude_none drops roleArn/providerArn/nameId if not supplied.
    item = req.model_dump(exclude_none=True)
    item["appId"] = app_id
    item["enabled"] = True
    item["createdAt"] = now
    item["updatedAt"] = now
    table.put_item(Item=item)
    write_audit_log(
        user["username"],
        "saml_app.create",
        app_id,
        {"displayName": req.displayName, "spEntityId": req.spEntityId},
        request,
    )
    return item


@router.get("/idp-metadata", response_class=Response)
async def download_idp_metadata(user: dict = Depends(current_user)) -> Response:
    """Build IdP metadata XML from S3/config — no outbound HTTP required.

    Reads the JWKS from the S3 hosting bucket directly (IAM access) and
    assembles the standard SAML IdP metadata XML inline. This avoids any
    outbound network dependency from the admin container.
    """
    import json
    import re
    import boto3

    table = get_table(settings.system_config_table)

    def _get(sk: str) -> str:
        resp = table.get_item(Key={"pk": "system", "sk": sk})
        return (resp.get("Item") or {}).get("value", "")

    entity_id    = _get("entity_id")
    saml_sso_url = _get("saml_sso_url")
    public_domain = _get("public_domain")
    client_name  = _get("client_name") or public_domain or "Verified ID"

    if not entity_id or not saml_sso_url:
        raise HTTPException(status_code=503, detail="SAML config not yet initialised (entity_id / saml_sso_url missing)")

    # Read x5c certificate from S3 hosting bucket (same creds as task role)
    try:
        s3 = boto3.client("s3", region_name=settings.aws_region)
        obj = s3.get_object(Bucket=settings.hosting_bucket, Key=".well-known/jwks.json")
        jwks = json.loads(obj["Body"].read())
        cert_b64 = jwks["keys"][0]["x5c"][0]
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Could not load signing certificate: {exc}") from exc

    # Build standard SAML 2.0 IdP metadata XML
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
                  entityID="{entity_id}">
  <IDPSSODescriptor WantAuthnRequestsSigned="false"
                    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data>
          <X509Certificate>{cert_b64}</X509Certificate>
        </X509Data>
      </KeyInfo>
    </KeyDescriptor>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
                         Location="{saml_sso_url}"/>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                         Location="{saml_sso_url}"/>
  </IDPSSODescriptor>
</EntityDescriptor>"""

    slug = re.sub(r"[^a-z0-9]+", "-", client_name.lower()).strip("-")
    filename = f"{slug}-idp-metadata.xml"

    return Response(
        content=xml.encode("utf-8"),
        media_type="application/xml",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{app_id}")
async def get_app(
    app_id: str,
    user: dict = Depends(current_user),
) -> dict:
    return _get_app_or_404(app_id)


@router.patch("/{app_id}")
async def update_app(
    app_id: str,
    req: UpdateSamlAppRequest,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    item = _get_app_or_404(app_id)

    update_data = req.model_dump(exclude_none=True, exclude_unset=True)
    if not update_data:
        return item

    # Reject attempts to change immutable fields
    for immutable in ("appId", "spEntityId"):
        update_data.pop(immutable, None)

    now = datetime.now(timezone.utc).isoformat()
    update_data["updatedAt"] = now

    # Build UpdateExpression
    set_parts = [f"#{k} = :{k}" for k in update_data]
    expr_names = {f"#{k}": k for k in update_data}
    expr_values = {f":{k}": v for k, v in update_data.items()}

    table = get_table(settings.app_table)
    resp = table.update_item(
        Key={"appId": app_id},
        UpdateExpression="SET " + ", ".join(set_parts),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
        ReturnValues="ALL_NEW",
    )
    updated = resp.get("Attributes", item)
    write_audit_log(
        user["username"],
        "saml_app.update",
        app_id,
        {"changed_fields": list(update_data.keys())},
        request,
    )
    return updated


@router.delete("/{app_id}")
async def delete_app(
    app_id: str,
    request: Request,
    user: dict = Depends(current_user),
) -> dict:
    """Soft-delete: sets enabled=false rather than removing the record."""
    _get_app_or_404(app_id)

    table = get_table(settings.app_table)
    now = datetime.now(timezone.utc).isoformat()
    table.update_item(
        Key={"appId": app_id},
        UpdateExpression="SET enabled = :f, updatedAt = :ts",
        ExpressionAttributeValues={":f": False, ":ts": now},
    )
    write_audit_log(user["username"], "saml_app.disable", app_id, {}, request)
    return {"status": "disabled", "appId": app_id}


