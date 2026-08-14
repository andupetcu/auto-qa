from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import Route
from app.deps import get_session, get_settings, require_auth
from app.services.discovery import seed_config_routes
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


class DiscoverBody(BaseModel):
    mode: str = "config"


def _serialize(route: Route) -> dict:
    return {
        "id": route.id,
        "base_url": route.base_url,
        "path": route.path,
        "discovery_source": route.discovery_source,
        "first_seen": route.first_seen.isoformat() if route.first_seen else None,
        "last_seen": route.last_seen.isoformat() if route.last_seen else None,
    }


@router.get("/routes")
def list_routes(session: Session = Depends(get_session)):
    rows = session.query(Route).order_by(Route.id).all()
    return [_serialize(r) for r in rows]


@router.post("/routes/discover")
def discover_routes(
    body: DiscoverBody,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    if body.mode == "config":
        seed_config_routes(session, settings)
    rows = session.query(Route).order_by(Route.id).all()
    return {"status": "ok", "routes": [_serialize(r) for r in rows]}
