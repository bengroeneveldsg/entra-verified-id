from __future__ import annotations

from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="",
        case_sensitive=False,
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # DynamoDB table names — injected by CDK as STATE_TABLE, APP_TABLE, etc.
    state_table: str = ""
    app_table: str = ""
    system_config_table: str = ""
    admin_users_table: str = ""
    audit_log_table: str = ""

    # S3
    hosting_bucket: str = ""

    # Secrets Manager secret names
    app_secret_name: str = ""
    jwt_secret_name: str = ""
    bootstrap_secret_name: str = ""

    # AWS / deployment — AWS_REGION is always injected by ECS; None lets boto3 read the env
    aws_region: Optional[str] = None
    admin_domain: str = ""
    stage: str = ""
    # Set to false when the admin ALB uses HTTP (no TLS cert).
    # Set to true in production when HTTPS is terminating at the ALB.
    secure_cookie: bool = True


settings = Settings()
