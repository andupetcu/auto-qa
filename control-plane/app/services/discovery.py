"""Route discovery: load routes config yaml, merge into the route table."""
from datetime import datetime, timezone

import yaml
from sqlalchemy.orm import Session

from app.db import Route
from app.ids import new_id
from app.settings import Settings


def load_routes_config(path: str) -> list[str]:
    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return []
    return list(data.get("routes", []))


def seed_config_routes(session: Session, settings: Settings) -> None:
    """Merge configured routes into the route table for base_url_default. Idempotent."""
    paths = load_routes_config(settings.routes_config)
    now = datetime.now(timezone.utc)
    for path in paths:
        existing = (
            session.query(Route)
            .filter_by(base_url=settings.base_url_default, path=path)
            .first()
        )
        if existing is not None:
            existing.last_seen = now
        else:
            session.add(
                Route(
                    id=new_id("rt"),
                    base_url=settings.base_url_default,
                    path=path,
                    discovery_source="config",
                    first_seen=now,
                    last_seen=now,
                )
            )
    session.commit()
