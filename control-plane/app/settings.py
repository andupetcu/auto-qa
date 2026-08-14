"""Application settings, sourced from QA_-prefixed env vars (and an optional repo-root .env)."""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# repo root is two levels above this file: control-plane/app/settings.py -> repo root
_REPO_ROOT = Path(__file__).resolve().parents[2]
_ENV_FILE = _REPO_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="QA_",
        env_file=str(_ENV_FILE) if _ENV_FILE.exists() else None,
        extra="ignore",
    )

    api_token: str = ""
    signing_secret: str = ""
    webhook_secret: str = ""
    webhook_urls: str = ""
    base_url_default: str = "http://localhost"
    database_url: str = "sqlite:///./var/qa.db"
    artifacts_dir: str = "./var/artifacts"
    routes_config: str = "./routes.yaml"
    runner_mode: str = "subprocess"
    roles: str = "user,anon"
    retention_full_days: int = 14

    @property
    def roles_list(self) -> list[str]:
        return [r.strip() for r in self.roles.split(",") if r.strip()]

    @property
    def webhook_url_list(self) -> list[str]:
        return [u.strip() for u in self.webhook_urls.split(",") if u.strip()]
