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
    credentials_file: str = str(_REPO_ROOT / ".env.credentials")
    role_matrix_fallback_path: str = str(_REPO_ROOT / "browser-worker" / "tests" / "role-matrix.yaml")
    scheduler_enabled: bool = True
    mcp_allowed_hosts: str = "127.0.0.1:*,localhost:*,[::1]:*"

    @property
    def roles_list(self) -> list[str]:
        return [r.strip() for r in self.roles.split(",") if r.strip()]

    @property
    def mcp_allowed_host_list(self) -> list[str]:
        return [host.strip() for host in self.mcp_allowed_hosts.split(",") if host.strip()]

    @property
    def webhook_url_list(self) -> list[str]:
        return [u.strip() for u in self.webhook_urls.split(",") if u.strip()]
