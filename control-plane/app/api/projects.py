"""Project CRUD: independently-testable targets with their own routes/roles/selectors."""
import re
from datetime import datetime, timezone

from croniter import croniter
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.runs import create_run_row
from app.db import Project, Route
from app.deps import get_session, get_settings, require_auth
from app.ids import new_id
from app.problems import ProblemException
from app.services.credentials import (
    read_credentials_status,
    user_credential_ref,
    write_credentials,
)
from app.services.target_policy import require_target_allowed, target_origin
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])

DEFAULT_ROLES = [{"name": "user", "credential_ref": "QA_CRED_USER"}, {"name": "anon"}]

# project and role names become filesystem path segments (.auth/<project>/<role>.json)
# and subprocess env values on the worker — since agents mint these autonomously via
# MCP, constrain them to a safe slug so a stray name can't escape the sessions dir.
_SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def _require_safe(kind: str, name: str) -> None:
    if not _SAFE_NAME.match(name or ""):
        raise ProblemException(
            400, f"Invalid {kind} name",
            f"{kind} name must match [a-z0-9][a-z0-9_-]{{0,63}}: {name!r}",
        )


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
    schedule_cron: str | None = None
    max_parallel: int | None = None
    enabled: bool | None = None


class CredentialsIn(BaseModel):
    username: str
    password: str
    totp_seed: str | None = None


class ProjectRunIn(BaseModel):
    routes: list[str] | None = None
    base_url: str | None = None
    app_version: str | None = None
    trigger: str = "manual"


class ProjectPatch(BaseModel):
    base_url_default: str | None = None
    roles: list[RoleIn] | None = None
    selectors: dict | None = None
    role_matrix: dict | None = None
    routes: list[str] | None = None
    schedule_cron: str | None = None
    max_parallel: int | None = None
    enabled: bool | None = None


def _get_project_or_404(session: Session, name: str) -> Project:
    project = session.query(Project).filter_by(name=name).first()
    if project is None:
        raise ProblemException(404, "Project not found", f"No project named {name}")
    return project


def get_project_by_id_or_name(session: Session, id_or_name: str) -> Project:
    """Resolve a project by its prj_ id first, falling back to its name."""
    project = None
    if id_or_name.startswith("prj_"):
        project = session.get(Project, id_or_name)
    if project is None:
        project = session.query(Project).filter_by(name=id_or_name).first()
    if project is None:
        raise ProblemException(404, "Project not found", f"No project {id_or_name!r}")
    return project


def _validate_schedule_cron(expression: str) -> None:
    try:
        croniter(expression, datetime.now(timezone.utc)).get_next(datetime)
    except (ValueError, KeyError, TypeError) as exc:
        raise ProblemException(
            400,
            "Invalid cron expression",
            f"Cron expression is invalid: {expression!r}",
        ) from exc


def _next_run_at(project: Project, now: datetime) -> str | None:
    if not project.enabled or not project.schedule_cron:
        return None
    try:
        next_fire = croniter(project.schedule_cron, now).get_next(datetime)
    except (ValueError, KeyError):
        return None
    if next_fire.tzinfo is None:
        next_fire = next_fire.replace(tzinfo=timezone.utc)
    return next_fire.isoformat()


def _serialize(session: Session, project: Project, settings: Settings) -> dict:
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
        "schedule_cron": project.schedule_cron,
        "max_parallel": project.max_parallel,
        "enabled": bool(project.enabled),
        "next_run_at": _next_run_at(project, datetime.now(timezone.utc)),
        "credentials": read_credentials_status(settings, project),
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


def _validate_roles(roles: list[RoleIn] | None) -> None:
    for r in roles or []:
        _require_safe("role", r.name)


@router.post("/projects", status_code=201)
def create_project(
    body: ProjectCreate,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    _require_safe("project", body.name)
    _validate_roles(body.roles)
    target_origin(body.base_url_default)
    if settings.target_allowed_origin_list:
        require_target_allowed(
            body.base_url_default, settings.target_allowed_origin_list
        )
    if body.schedule_cron is not None:
        _validate_schedule_cron(body.schedule_cron)
    existing = session.query(Project).filter_by(name=body.name).first()
    if existing is not None:
        raise ProblemException(
            409, "Project already exists", f"A project named {body.name} already exists"
        )

    roles = [r.model_dump(exclude_none=True) for r in body.roles] if body.roles else DEFAULT_ROLES
    now = datetime.now(timezone.utc)
    project = Project(
        id=new_id("prj"),
        name=body.name,
        base_url_default=body.base_url_default,
        selectors=body.selectors or {},
        roles=roles,
        role_matrix=body.role_matrix or {},
        created_at=now,
        schedule_cron=body.schedule_cron,
        last_scheduled_at=now if body.schedule_cron is not None else None,
        max_parallel=body.max_parallel if body.max_parallel is not None else 2,
        enabled=body.enabled if body.enabled is not None else True,
    )
    session.add(project)
    session.flush()

    if body.routes:
        _replace_routes(session, project, body.routes)

    session.commit()
    return _serialize(session, project, settings)


@router.get("/projects")
def list_projects(
    session: Session = Depends(get_session), settings: Settings = Depends(get_settings)
):
    rows = session.query(Project).order_by(Project.id).all()
    return [_serialize(session, p, settings) for p in rows]


@router.get("/projects/{name}")
def get_project(
    name: str,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    project = _get_project_or_404(session, name)
    return _serialize(session, project, settings)


@router.patch("/projects/{name}")
def patch_project(
    name: str,
    body: ProjectPatch,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    _validate_roles(body.roles)
    project = _get_project_or_404(session, name)
    was_enabled = project.enabled

    if body.base_url_default is not None:
        target_origin(body.base_url_default)
        if settings.target_allowed_origin_list:
            require_target_allowed(
                body.base_url_default, settings.target_allowed_origin_list
            )
        project.base_url_default = body.base_url_default
    if body.selectors is not None:
        project.selectors = body.selectors
    if body.role_matrix is not None:
        project.role_matrix = body.role_matrix
    if body.roles is not None:
        project.roles = [r.model_dump(exclude_none=True) for r in body.roles]
    if body.routes is not None:
        _replace_routes(session, project, body.routes)
    if body.schedule_cron is not None:
        _validate_schedule_cron(body.schedule_cron)
        project.schedule_cron = body.schedule_cron
        project.last_scheduled_at = datetime.now(timezone.utc)
    if body.max_parallel is not None:
        project.max_parallel = body.max_parallel
    if body.enabled is not None:
        project.enabled = body.enabled
        if body.enabled and not was_enabled and project.schedule_cron:
            project.last_scheduled_at = datetime.now(timezone.utc)

    session.commit()
    return _serialize(session, project, settings)


@router.put("/projects/{id_or_name}/credentials", status_code=204)
def set_project_credentials(
    id_or_name: str,
    body: CredentialsIn,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    project = get_project_by_id_or_name(session, id_or_name)

    write_credentials(settings, project, body.username, body.password, body.totp_seed)

    cred_ref = user_credential_ref(project.id)
    roles = [dict(r) for r in (project.roles or [])]
    for r in roles:
        if r.get("name") == "user":
            r["credential_ref"] = cred_ref
            break
    else:
        roles.append({"name": "user", "credential_ref": cred_ref})
    project.roles = roles
    project.cred_ref = cred_ref

    session.commit()


@router.post("/projects/{id_or_name}/run", status_code=202)
def run_project(
    id_or_name: str,
    body: ProjectRunIn,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    project = get_project_by_id_or_name(session, id_or_name)
    run = create_run_row(
        session,
        settings,
        project,
        routes=body.routes or ["ALL"],
        roles=[r["name"] for r in (project.roles or [])],
        base_url=body.base_url,
        app_version=body.app_version,
        trigger=body.trigger,
    )
    return {"run_id": run.id, "status": "queued"}
