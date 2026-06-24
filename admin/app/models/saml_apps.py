"""Pydantic v2 models for SAML application management."""
from __future__ import annotations

from typing import List, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


# Allowed Verified ID claim keys (VerifiedEmployee credential)
VID_CLAIMS = [
    "displayName",
    "givenName",
    "surname",
    "mail",
    "userPrincipalName",
    "jobTitle",
    "department",
    "employeeId",
]

NAMEID_FORMATS = [
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
    "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
]


class SamlAttribute(BaseModel):
    """A single SAML attribute entry — name, format, source, and value."""
    model_config = ConfigDict(populate_by_name=True)

    name: str = Field(..., min_length=1)
    nameFormat: str = "urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
    source: Literal["claim", "static"] = "claim"
    value: str = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_claim_key(self) -> "SamlAttribute":
        if self.source == "claim" and self.value not in VID_CLAIMS:
            raise ValueError(
                f"value {self.value!r} is not a valid VID claim key; "
                f"allowed: {', '.join(VID_CLAIMS)}"
            )
        return self


class NameIdConfig(BaseModel):
    """NameID configuration — format and value source."""
    model_config = ConfigDict(populate_by_name=True)

    format: Literal[
        "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
        "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
    ] = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    source: Literal["claim", "static"] = "claim"
    value: str = "mail"  # claim key or static literal; "" => legacy mail→upn→email fallback

    @model_validator(mode="after")
    def validate_claim_key(self) -> "NameIdConfig":
        if self.source == "claim" and self.value and self.value not in VID_CLAIMS:
            raise ValueError(
                f"value {self.value!r} is not a valid VID claim key; "
                f"allowed: {', '.join(VID_CLAIMS)}"
            )
        return self


class SamlApp(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    appId: str
    spEntityId: str
    acsUrl: str
    relayState: str = ""
    # Legacy AWS fields — retained for read-compat; no longer required for new apps
    roleArn: str | None = None
    providerArn: str | None = None
    sessionName: str = "VerifiedIDSession"
    sessionDuration: int = 3600
    displayName: str
    description: str = ""   # user-facing description shown on the landing page tile
    allowedGroupIds: List[str] = Field(default_factory=list)
    enabled: bool = True
    createdAt: str
    updatedAt: str
    # Generic attribute mapping — the single source of truth for assertion emission
    attributes: List[SamlAttribute] = Field(default_factory=list)
    nameId: NameIdConfig | None = None


class CreateSamlAppRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    spEntityId: str = Field(..., min_length=1)
    acsUrl: str = Field(..., min_length=1)
    relayState: str = ""
    # Legacy AWS fields — optional; supply custom attributes instead for non-AWS apps
    roleArn: str | None = None
    providerArn: str | None = None
    sessionName: str = "VerifiedIDSession"
    sessionDuration: int = Field(default=3600, ge=900, le=43200)
    displayName: str = Field(..., min_length=1)
    description: str = Field(default="", max_length=120)
    allowedGroupIds: List[str] = Field(default_factory=list)
    attributes: List[SamlAttribute] = Field(default_factory=list)
    nameId: NameIdConfig | None = None


class UpdateSamlAppRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    acsUrl: str | None = None
    relayState: str | None = None
    roleArn: str | None = None
    providerArn: str | None = None
    sessionName: str | None = None
    sessionDuration: int | None = Field(default=None, ge=900, le=43200)
    displayName: str | None = None
    description: str | None = Field(default=None, max_length=120)
    allowedGroupIds: List[str] | None = None
    enabled: bool | None = None
    attributes: List[SamlAttribute] | None = None
    nameId: NameIdConfig | None = None
