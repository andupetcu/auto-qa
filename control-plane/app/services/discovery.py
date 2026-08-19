"""Route discovery: load routes config yaml, merge into the route table."""
from datetime import datetime, timezone

import yaml
from sqlalchemy.orm import Session

from app.db import Project, Route
from app.ids import new_id
from app.settings import Settings

DEFAULT_PROJECT_NAME = "default"


def load_routes_config(path: str) -> list[str]:
    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return []
    return list(data.get("routes", []))


def default_roles_from_names(role_names: list[str]) -> list[dict]:
    """Map bare role names (settings.roles, e.g. "user,anon") to role config dicts.

    Every role except "anon" gets a credential_ref pointing at QA_CRED_<ROLE>;
    "anon" carries no credential (it never authenticates).
    """
    roles = []
    for name in role_names:
        if name == "anon":
            roles.append({"name": name})
        else:
            roles.append({"name": name, "credential_ref": f"QA_CRED_{name.upper()}"})
    return roles


def ensure_default_project(session: Session, settings: Settings) -> Project:
    """Ensure the default project exists, seeded from settings. Idempotent."""
    project = session.query(Project).filter_by(name=DEFAULT_PROJECT_NAME).first()
    if project is None:
        project = Project(
            id=new_id("prj"),
            name=DEFAULT_PROJECT_NAME,
            base_url_default=settings.base_url_default,
            selectors={},
            roles=default_roles_from_names(settings.roles_list),
            role_matrix={},
            created_at=datetime.now(timezone.utc),
        )
        session.add(project)
        session.commit()
    return project


def seed_config_routes(session: Session, settings: Settings, project: Project) -> None:
    """Merge configured routes into the route table for `project`. Idempotent."""
    paths = load_routes_config(settings.routes_config)
    now = datetime.now(timezone.utc)
    for path in paths:
        existing = (
            session.query(Route)
            .filter_by(project_id=project.id, path=path)
            .first()
        )
        if existing is not None:
            existing.last_seen = now
        else:
            session.add(
                Route(
                    id=new_id("rt"),
                    project_id=project.id,
                    path=path,
                    discovery_source="config",
                    first_seen=now,
                    last_seen=now,
                )
            )
    session.commit()
