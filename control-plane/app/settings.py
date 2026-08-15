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
    target_allowed_origins: str = ""
    database_url: str = "sqlite:///./var/qa.db"
    artifacts_dir: str = "./var/artifacts"
    routes_config: str = "./routes.yaml"
    runner_mode: str = "subprocess"
    roles: str = "user,anon"
    retention_full_days: int = 14
    evidence_redact_headers: str = "authorization,cookie,set-cookie,x-api-key"
    evidence_redact_query_keys: str = "token,code,session,csrf,api_key,apikey"
    evidence_redact_json_keys: str = "password,accessToken,refreshToken,token,session,csrf,apiKey"
    evidence_max_body_bytes: int = 16384
    evidence_max_artifacts_per_result: int = 20
    evidence_max_artifact_bytes_per_result: int = 104857600
    evidence_max_artifact_bytes_per_run: int = 524288000
    evidence_project_quota_bytes: int = 5368709120
    evidence_min_free_disk_bytes: int = 1073741824
    evidence_orphan_grace_seconds: int = 3600
    cleanup_enabled: bool = True
    cleanup_interval_seconds: int = 3600
    capture_max_frames: int = 6
    capture_max_delay_ms: int = 3000
    capture_max_mask_selectors: int = 20
    capture_max_contact_sheet_quality: int = 90
    capture_contact_sheet_max_pixels: int = 16777216
    capture_contact_sheet_max_bytes: int = 4194304
    credentials_file: str = str(_REPO_ROOT / ".env.credentials")
    role_matrix_fallback_path: str = str(_REPO_ROOT / "browser-worker" / "tests" / "role-matrix.yaml")
    scheduler_enabled: bool = True
    mcp_allowed_hosts: str = "127.0.0.1:*,localhost:*,[::1]:*"

    @property
    def target_allowed_origin_list(self) -> list[str]:
        """Installation-level exact or wildcard origins allowed for browser targets."""
        return [
            origin.strip()
            for origin in self.target_allowed_origins.split(",")
            if origin.strip()
        ]

    @property
    def roles_list(self) -> list[str]:
        return [r.strip() for r in self.roles.split(",") if r.strip()]

    @property
    def mcp_allowed_host_list(self) -> list[str]:
        return [host.strip() for host in self.mcp_allowed_hosts.split(",") if host.strip()]

    @property
    def webhook_url_list(self) -> list[str]:
        return [u.strip() for u in self.webhook_urls.split(",") if u.strip()]
