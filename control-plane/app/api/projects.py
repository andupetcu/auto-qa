"""Project CRUD: independently-testable targets with their own routes/roles/selectors."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import Project, Route
from app.deps import get_session, require_auth
from app.ids import new_id
from app.problems import ProblemException

router = APIRouter(dependencies=[Depends(require_auth)])

DEFAULT_ROLES = [{"name": "user", "credential_ref": "QA_CRED_USER"}, {"name": "anon"}]


class RoleIn(BaseModel):
    name: str
    credential_ref: str | None = None


class ProjectCreate(BaseModel):
    name: str
    base_url_default: str
    roles: list[RoleIn] | None = None
    selectors: dict | None = None
    role_matrix: dict | None = None
    routes: list[str] | None = None


class ProjectPatch(BaseModel):
    base_url_default: str | None = None
    roles: list[RoleIn] | None = None
    selectors: dict | None = None
    role_matrix: dict | None = None
    routes: list[str] | None = None


def _get_project_or_404(session: Session, name: str) -> Project:
    project = session.query(Project).filter_by(name=name).first()
    if project is None:
        raise ProblemException(404, "Project not found", f"No project named {name}")
    return project


def _serialize(session: Session, project: Project) -> dict:
    routes_count = session.query(Route).filter_by(project_id=project.id).count()
    return {
        "id": project.id,
        "name": project.name,
        "base_url_default": project.base_url_default,
        "selectors": project.selectors,
        "roles": project.roles,
        "role_matrix": project.role_matrix,
        "routes_count": routes_count,
        "created_at": project.created_at.isoformat() if project.created_at else None,
    }


def _replace_routes(session: Session, project: Project, paths: list[str]) -> None:
    now = datetime.now(timezone.utc)
    existing = {r.path: r for r in session.query(Route).filter_by(project_id=project.id).all()}
    keep = set(paths)
    for path, row in existing.items():
        if path not in keep:
            session.delete(row)
    for path in paths:
        if path in existing:
            existing[path].last_seen = now
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


@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate, session: Session = Depends(get_session)):
    existing = session.query(Project).filter_by(name=body.name).first()
    if existing is not None:
        raise ProblemException(
            409, "Project already exists", f"A project named {body.name} already exists"
        )

    roles = [r.model_dump(exclude_none=True) for r in body.roles] if body.roles else DEFAULT_ROLES
    project = Project(
        id=new_id("prj"),
        name=body.name,
        base_url_default=body.base_url_default,
        selectors=body.selectors or {},
        roles=roles,
        role_matrix=body.role_matrix or {},
        created_at=datetime.now(timezone.utc),
    )
    session.add(project)
    session.flush()

    if body.routes:
        _replace_routes(session, project, body.routes)

    session.commit()
    return _serialize(session, project)


@router.get("/projects")
def list_projects(session: Session = Depends(get_session)):
    rows = session.query(Project).order_by(Project.id).all()
    return [_serialize(session, p) for p in rows]


@router.get("/projects/{name}")
def get_project(name: str, session: Session = Depends(get_session)):
    project = _get_project_or_404(session, name)
    return _serialize(session, project)


@router.patch("/projects/{name}")
def patch_project(name: str, body: ProjectPatch, session: Session = Depends(get_session)):
    project = _get_project_or_404(session, name)

    if body.base_url_default is not None:
        project.base_url_default = body.base_url_default
    if body.selectors is not None:
        project.selectors = body.selectors
    if body.role_matrix is not None:
        project.role_matrix = body.role_matrix
    if body.roles is not None:
        project.roles = [r.model_dump(exclude_none=True) for r in body.roles]
    if body.routes is not None:
        _replace_routes(session, project, body.routes)

    session.commit()
    return _serialize(session, project)
