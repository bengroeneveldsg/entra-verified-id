"""Pydantic v2 models for the setup / onboarding wizard."""
from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SetupStatusResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    onboarding_complete: bool
    current_step: int
    has_bootstrap_secret: bool


# ---------------------------------------------------------------------------
# Step 1 – admin user
# ---------------------------------------------------------------------------

_PASSWORD_RE = re.compile(
    r"^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':\"\\|,.<>\/?]).{12,}$"
)


class SetupAdminUserRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    email: str = Field(..., min_length=3)
    password: str = Field(..., min_length=12)

    @field_validator("password")
    @classmethod
    def password_complexity(cls, v: str) -> str:
        if not _PASSWORD_RE.match(v):
            raise ValueError(
                "Password must be at least 12 characters and contain uppercase, "
                "lowercase, digits, and special characters."
            )
        return v


# ---------------------------------------------------------------------------
# Step 2 – tenant / app registrations
# ---------------------------------------------------------------------------

class SetupTenantRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    tenant_id: str = Field(..., min_length=1)
    issuer_verifier_client_id: str = Field(..., min_length=1)
    issuer_verifier_client_secret: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Step 3 – DID
# ---------------------------------------------------------------------------

class SetupDidRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    authority: str = Field(..., min_length=1)
    manifest_url: str = Field(..., min_length=1)
    accepted_issuer: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Step 4 – domain
# ---------------------------------------------------------------------------

class SetupDomainRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    public_domain: str = Field(..., min_length=1)
    api_domain: str = Field(..., min_length=1)
    frontend_base_url: str = Field(..., min_length=1)
    client_name: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Step 5 – signing keys
# ---------------------------------------------------------------------------

class SetupKeysRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    generate_new: bool = True
    existing_pem: str | None = None
