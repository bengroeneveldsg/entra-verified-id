"""SAML application CRUD routes."""
from __future__ import annotations

import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status

from app.auth import current_user, write_audit_log
from app.deps import get_table
from app.models.saml_apps import CreateSamlAppRequest, SamlApp, UpdateSamlAppRequest
from app.settings import settings

router = APIRouter(prefix="/saml-apps", tags=["saml-apps"])


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

    item = {
        "appId": app_id,
        "spEntityId": req.spEntityId,
        "acsUrl": req.acsUrl,
        "relayState": req.relayState,
        "roleArn": req.roleArn,
        "providerArn": req.providerArn,
        "sessionName": req.sessionName,
        "sessionDuration": req.sessionDuration,
        "displayName": req.displayName,
        "allowedGroupIds": req.allowedGroupIds,
        "enabled": True,
        "createdAt": now,
        "updatedAt": now,
    }
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


