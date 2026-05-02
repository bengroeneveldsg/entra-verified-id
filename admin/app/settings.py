from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="",
        case_sensitive=False,
        env_file=".env",
        env_file_encoding="utf-8",
    )

    # DynamoDB table names
    state_table: str = "VidSessions"
    app_table: str = "SamlApps"
    system_config_table: str = "SystemConfig"
    admin_users_table: str = "AdminUsers"
    audit_log_table: str = "AuditLog"

    # S3
    hosting_bucket: str = ""

    # Secrets Manager secret names
    app_secret_name: str = ""
    jwt_secret_name: str = ""
    bootstrap_secret_name: str = ""

    # AWS / deployment
    aws_region: str = "us-east-1"
    admin_domain: str = ""
    stage: str = "prod"
    # Set to false when the admin ALB uses HTTP (no TLS cert).
    # Set to true in production when HTTPS is terminating at the ALB.
    secure_cookie: bool = True


settings = Settings()
