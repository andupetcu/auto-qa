from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import Project, Route
from app.deps import get_session, get_settings, require_auth
from app.problems import ProblemException
from app.services.discovery import DEFAULT_PROJECT_NAME, seed_config_routes
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


class DiscoverBody(BaseModel):
    mode: str = "config"
    project: str = DEFAULT_PROJECT_NAME


def _get_project_or_404(session: Session, name: str) -> Project:
    project = session.query(Project).filter_by(name=name).first()
    if project is None:
        raise ProblemException(404, "Project not found", f"No project named {name}")
    return project


def _serialize(route: Route, project: Project) -> dict:
    return {
        "id": route.id,
        "base_url": project.base_url_default,
        "path": route.path,
        "discovery_source": route.discovery_source,
        "first_seen": route.first_seen.isoformat() if route.first_seen else None,
        "last_seen": route.last_seen.isoformat() if route.last_seen else None,
    }


@router.get("/routes")
def list_routes(project: str = DEFAULT_PROJECT_NAME, session: Session = Depends(get_session)):
    proj = _get_project_or_404(session, project)
    rows = session.query(Route).filter_by(project_id=proj.id).order_by(Route.id).all()
    return [_serialize(r, proj) for r in rows]


@router.post("/routes/discover")
def discover_routes(
    body: DiscoverBody,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    proj = _get_project_or_404(session, body.project)
    if body.mode == "config":
        seed_config_routes(session, settings, proj)
    rows = session.query(Route).filter_by(project_id=proj.id).order_by(Route.id).all()
    return {"status": "ok", "routes": [_serialize(r, proj) for r in rows]}
