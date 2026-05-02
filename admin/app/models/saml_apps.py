"""Pydantic v2 models for SAML application management."""
from __future__ import annotations

from typing import List

from pydantic import BaseModel, ConfigDict, Field


class SamlApp(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    appId: str
    spEntityId: str
    acsUrl: str
    relayState: str = ""
    roleArn: str
    providerArn: str
    sessionName: str = "VerifiedIDSession"
    sessionDuration: int = 3600
    displayName: str
    description: str = ""   # user-facing description shown on the landing page tile
    allowedGroupIds: List[str] = Field(default_factory=list)
    enabled: bool = True
    createdAt: str
    updatedAt: str


class CreateSamlAppRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    spEntityId: str = Field(..., min_length=1)
    acsUrl: str = Field(..., min_length=1)
    relayState: str = ""
    roleArn: str = Field(..., min_length=1)
    providerArn: str = Field(..., min_length=1)
    sessionName: str = "VerifiedIDSession"
    sessionDuration: int = Field(default=3600, ge=900, le=43200)
    displayName: str = Field(..., min_length=1)
    description: str = Field(default="", max_length=120)
    allowedGroupIds: List[str] = Field(default_factory=list)


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
