"""Project credentials: written to a chmod-0600 secrets file, never to SQLite.

The control plane only ever stores *references* to credentials (env var key names)
in the database; the actual username/password/TOTP seed values live in a flat
`KEY=VALUE` file (default `<repo_root>/.env.credentials`) that the browser-worker
subprocess loads into its environment at spawn time.
"""
import os
import stat
from pathlib import Path

from app.db import Project
from app.settings import Settings


def key_prefix(project_id: str) -> str:
    """The env-var key prefix for a project's credentials, e.g. QA_PRJ_PRJ_01J...."""
    return f"QA_PRJ_{project_id.upper()}"


def user_credential_ref(project_id: str) -> str:
    """The credential_ref value stamped onto the project's `user` role."""
    return f"{key_prefix(project_id)}_USER"


def _read_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return path.read_text().splitlines()


def _parse_env(lines: list[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        env[key.strip()] = value.strip()
    return env


def write_credentials(
    settings: Settings,
    project: Project,
    username: str,
    password: str,
    totp_seed: str | None = None,
) -> None:
    """Append-or-replace this project's credential keys in the secrets file.

    Preserves every other line untouched. Creates the file chmod 0600 if absent,
    and re-asserts that mode on every write.
    """
    path = Path(settings.credentials_file)
    path.parent.mkdir(parents=True, exist_ok=True)

    prefix = key_prefix(project.id)
    updates = {f"{prefix}_USER_EMAIL": username, f"{prefix}_PASSWORD": password}
    if totp_seed:
        updates[f"{prefix}_TOTP_SEED"] = totp_seed

    lines = _read_lines(path)
    remaining = dict(updates)
    new_lines = []
    for line in lines:
        stripped = line.strip()
        key = stripped.partition("=")[0].strip() if "=" in stripped else None
        if key in remaining:
            new_lines.append(f"{key}={remaining.pop(key)}")
        else:
            new_lines.append(line)
    for key, value in remaining.items():
        new_lines.append(f"{key}={value}")

    path.write_text("\n".join(new_lines) + "\n")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def read_credentials_status(settings: Settings, project: Project) -> dict:
    """{username, has_password, has_totp} for `project` — booleans only, never secrets."""
    path = Path(settings.credentials_file)
    env = _parse_env(_read_lines(path))
    prefix = key_prefix(project.id)
    return {
        "username": env.get(f"{prefix}_USER_EMAIL") or None,
        "has_password": bool(env.get(f"{prefix}_PASSWORD")),
        "has_totp": bool(env.get(f"{prefix}_TOTP_SEED")),
    }
