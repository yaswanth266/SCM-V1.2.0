import os
from pydantic import field_validator
from pydantic_settings import BaseSettings
from typing import List
from urllib.parse import quote_plus
import json


class Settings(BaseSettings):
    # Database
    DB_HOST: str = "localhost"
    DB_PORT: int = 3306
    DB_USER: str = "root"
    DB_PASSWORD: str = ""
    DB_NAME: str = "bhspl_scm"

    # JWT — access and refresh tokens use DIFFERENT secrets (B7 fix)
    JWT_SECRET_KEY: str = "CHANGE_ME_BEFORE_PRODUCTION"
    JWT_REFRESH_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    # BUG-AUTH-035 (Wave 5): optional asymmetric (RS256/RS384/RS512) signing.
    # Set JWT_ALGORITHM=RS256 plus paths to a PEM private/public keypair to
    # enable. Falls back to HS256 if either path is unset/unreadable.
    JWT_PRIVATE_KEY_PATH: str = ""
    JWT_PUBLIC_KEY_PATH: str = ""
    # BUG-AUTH-037: 60-min access TTL was too long without revocation. Lower
    # the default to 30 minutes; deployments that need the old value can
    # still override via JWT_ACCESS_TOKEN_EXPIRE_MINUTES in .env.
    JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    JWT_REFRESH_TOKEN_EXPIRE_DAYS: int = 7

    # BUG-AUTH-038: cap the refresh-token TTL so a misconfigured .env can't
    # accidentally hand out year-long credentials. 30 days mirrors industry
    # norms; deployments that need a different value can override the
    # constant in code, but env-driven changes are clamped.
    _JWT_REFRESH_TOKEN_MAX_DAYS: int = 30

    # App
    APP_NAME: str = "BHSPL SCM ERP"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    CORS_ORIGINS: str = '["http://localhost:3000","http://localhost:5173"]'

    # File uploads
    UPLOAD_DIR: str = "./uploads"
    MAX_UPLOAD_SIZE: int = 10485760
    ALLOWED_UPLOAD_EXTENSIONS: str = '.pdf,.jpg,.jpeg,.png,.gif,.xlsx,.xls,.csv,.doc,.docx'

    # Email
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM_EMAIL: str = "noreply@bhspl.com"

    # Rate Limiting
    RATE_LIMIT_STORAGE_URI: str = "memory://"

    # External employee master API. Keep the API key in backend/.env only.
    HR_EMPLOYEE_API_URL: str = ""
    HR_API_KEY: str = ""
    HR_API_TIMEOUT: int = 30

    @property
    def effective_refresh_token_days(self) -> int:
        """Clamp env-driven refresh TTL to the documented upper bound."""
        return max(1, min(self.JWT_REFRESH_TOKEN_EXPIRE_DAYS, self._JWT_REFRESH_TOKEN_MAX_DAYS))

    @field_validator("DEBUG", mode="before")
    @classmethod
    def parse_debug_flag(cls, value):
        """Accept common environment labels in addition to strict booleans."""
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"1", "true", "yes", "on", "debug", "dev", "development"}:
                return True
            if normalized in {"0", "false", "no", "off", "release", "prod", "production"}:
                return False
        return value

    @property
    def DATABASE_URL(self) -> str:
        return f"mysql+aiomysql://{quote_plus(self.DB_USER)}:{quote_plus(self.DB_PASSWORD)}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}?charset=utf8mb4"

    @property
    def cors_origins_list(self) -> List[str]:
        try:
            return json.loads(self.CORS_ORIGINS)
        except (json.JSONDecodeError, TypeError):
            return ["http://localhost:3000"]

    @property
    def allowed_extensions_list(self) -> List[str]:
        return [e.strip().lower() for e in self.ALLOWED_UPLOAD_EXTENSIONS.split(",")]

    _backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _env_file_path = os.path.join(_backend_dir, ".env")

    model_config = {
        "env_file": _env_file_path,
        "env_file_encoding": "utf-8",
        "case_sensitive": True,
    }


settings = Settings()
