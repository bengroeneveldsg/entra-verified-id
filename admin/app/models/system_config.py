"""Pydantic v2 models for system configuration."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class SystemConfigItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str
    value: str
    updated_at: str
    updated_by: str


class UpdateConfigRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str = Field(..., min_length=1)
    value: str
