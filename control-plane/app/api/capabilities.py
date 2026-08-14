from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import Project
from app.deps import get_session, get_settings, require_auth
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])

ARTIFACT_TYPES = ["trace", "har", "console", "screenshot", "video"]


@router.get("/capabilities")
def get_capabilities(
    settings: Settings = Depends(get_settings),
    session: Session = Depends(get_session),
):
    projects = [p.name for p in session.query(Project).order_by(Project.id).all()]
    return {
        "version": "0.1",
        "roles": settings.roles_list,
        "artifact_types": ARTIFACT_TYPES,
        "projects": projects,
    }
