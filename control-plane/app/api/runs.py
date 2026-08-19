"""Run lifecycle, result queries, cancellation and deterministic rerun APIs."""

from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.db import FailureCluster, Project, Route, TestResult, TestRun
from app.deps import get_session, get_settings, require_auth
from app.ids import new_id
from app.problems import ProblemException
from app.serializers import serialize_result, serialize_run
from app.services.capture_policy import normalize_capture_policy
from app.services.discovery import DEFAULT_PROJECT_NAME
from app.services.runner import maybe_spawn
from app.services.target_policy import require_target_allowed
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])

SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}


class RunCreate(BaseModel):
    routes: list[str]
    project: str = DEFAULT_PROJECT_NAME
    roles: list[str] | None = None
    browsers: list[str] | None = None
    viewports: list[str] | None = None
    base_url: str | None = None
    app_version: str | None = None
    capture: dict | None = None

    @field_validator("browsers", "viewports")
    @classmethod
    def require_single_execution_selector(
        cls, value: list[str] | None
    ) -> list[str] | None:
        if value is not None and len(value) > 1:
            raise ValueError("select at most one value per worker run")
        return value


class RerunBody(BaseModel):
    scope: Literal["failed", "affected", "full", "result"]
    result_id: str | None = None
    base_url: str | None = None
    app_version: str | None = None


def _get_run_or_404(session: Session, run_id: str) -> TestRun:
    run = session.get(TestRun, run_id)
    if run is None:
        raise ProblemException(404, "Run not found", f"No run with id {run_id}")
    return run


def _get_project_or_400(session: Session, name: str) -> Project:
    project = session.query(Project).filter_by(name=name).first()
    if project is None:
        raise ProblemException(400, "Unknown project", f"Unknown project: {name}")
    return project


def _project_name(session: Session, project_id: str | None) -> str | None:
    if project_id is None:
        return None
    project = session.get(Project, project_id)
    return project.name if project else None


def _create_run_row_unlocked(
    session: Session,
    settings: Settings,
    project: Project,
    routes: list[str],
    roles: list[str] | None = None,
    base_url: str | None = None,
    app_version: str | None = None,
    trigger: str = "manual",
    browsers: list[str] | None = None,
    viewports: list[str] | None = None,
    capture: dict | None = None,
    idempotency_key: str | None = None,
    parent_run_id: str | None = None,
    validate_routes: bool = True,
) -> TestRun:
    """Persist and spawn one run while the caller holds the project run lock."""
    # Resolve "ALL" sentinel: expand to the actual stored route paths so the worker
    # receives an explicit list and can generate the test matrix without needing to
    # query the control-plane API or rely on a fallback YAML file.
    if routes == ["ALL"]:
        db_routes = session.query(Route).filter_by(project_id=project.id).order_by(Route.id).all()
        if db_routes:
            routes = [r.path for r in db_routes]
        # If no routes in DB, keep ["ALL"] — worker falls back to role-matrix.yaml
    elif validate_routes:
        known_paths = {
            r.path for r in session.query(Route).filter_by(project_id=project.id).all()
        }
        for path in routes:
            if path not in known_paths:
                raise ProblemException(
                    400, "Unknown route", f"Unknown route for {project.name}: {path}"
                )

    project_role_names = [role["name"] for role in (project.roles or [])]
    requested_roles = roles or project_role_names
    unknown_roles = sorted(set(requested_roles) - set(project_role_names))
    if unknown_roles:
        raise ProblemException(
            400,
            "Unknown role",
            f"Roles not configured for project {project.name!r}: {unknown_roles}",
        )

    target_url = base_url or project.base_url_default
    allowed_origins = settings.target_allowed_origin_list or [project.base_url_default]
    require_target_allowed(target_url, allowed_origins)

    project_readiness = (
        project.selectors.get("readiness")
        if isinstance(project.selectors, dict)
        and isinstance(project.selectors.get("readiness"), dict)
        else None
    )
    capture_config = normalize_capture_policy(
        capture, settings, project_readiness=project_readiness
    )
    run_id = new_id("run")
    run = TestRun(
        id=run_id,
        project_id=project.id,
        trigger=trigger,
        base_url=target_url,
        app_version=app_version,
        requested_routes=routes,
        requested_roles=requested_roles,
        browsers=browsers or [],
        viewports=viewports or [],
        capture_config=capture_config,
        idempotency_key=idempotency_key,
        parent_run_id=parent_run_id,
        started_at=None,
        ended_at=None,
        status="queued",
        totals=None,
        detail=None,
    )
    session.add(run)
    session.commit()

    maybe_spawn(run, project, settings)  # sets run.worker_pid
    session.commit()
    return run


def create_run_row(
    session: Session,
    settings: Settings,
    project: Project,
    routes: list[str],
    roles: list[str] | None = None,
    base_url: str | None = None,
    app_version: str | None = None,
    trigger: str = "manual",
    browsers: list[str] | None = None,
    viewports: list[str] | None = None,
    capture: dict | None = None,
    idempotency_key: str | None = None,
    parent_run_id: str | None = None,
    validate_routes: bool = True,
) -> TestRun:
    """Serialize run creation and prevent manual work from entering an active schedule."""
    from app.services.project_run_lock import project_run_lock

    with project_run_lock(project.id):
        session.expire_all()
        project = session.get(Project, project.id)
        if project is None:
            raise ProblemException(400, "Unknown project", "Project was deleted")
        if trigger != "schedule":
            active_schedule = (
                session.query(TestRun)
                .filter(
                    TestRun.project_id == project.id,
                    TestRun.trigger == "schedule",
                    TestRun.status.in_(("queued", "running")),
                )
                .first()
            )
            if active_schedule is not None:
                raise ProblemException(
                    409,
                    "Scheduled run active",
                    f"Project {project.name!r} has active scheduled run {active_schedule.id}",
                )
        return _create_run_row_unlocked(
            session,
            settings,
            project,
            routes,
            roles=roles,
            base_url=base_url,
            app_version=app_version,
            trigger=trigger,
            browsers=browsers,
            viewports=viewports,
            capture=capture,
            idempotency_key=idempotency_key,
            parent_run_id=parent_run_id,
            validate_routes=validate_routes,
        )


@router.post("/runs", status_code=202)
def create_run(
    body: RunCreate,
    request: Request,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    idem_key = request.headers.get("Idempotency-Key")
    if idem_key:
        existing = session.query(TestRun).filter_by(idempotency_key=idem_key).first()
        if existing is not None:
            return {"run_id": existing.id, "status": existing.status}

    project = _get_project_or_400(session, body.project)

    run = create_run_row(
        session,
        settings,
        project,
        routes=body.routes,
        roles=body.roles,
        base_url=body.base_url,
        app_version=body.app_version,
        trigger="manual",
        browsers=body.browsers,
        viewports=body.viewports,
        capture=body.capture,
        idempotency_key=idem_key,
    )

    return {"run_id": run.id, "status": "queued"}


@router.get("/runs")
def list_runs(
    project: str | None = None,
    status: str | None = None,
    trigger: str | None = None,
    before: str | None = None,
    limit: int = Query(default=50, ge=1, le=500),
    session: Session = Depends(get_session),
):
    """Return newest runs first with deterministic cursor-based filtering."""
    query = session.query(TestRun, Project.name).outerjoin(
        Project, TestRun.project_id == Project.id
    )
    if project is not None:
        query = query.filter(Project.name == project)
    if status is not None:
        query = query.filter(TestRun.status == status)
    if trigger is not None:
        query = query.filter(TestRun.trigger == trigger)
    if before is not None:
        query = query.filter(TestRun.id < before)

    rows = query.order_by(TestRun.id.desc()).limit(limit).all()
    return [serialize_run(run, project_name) for run, project_name in rows]


@router.get("/runs/{run_id}")
def get_run(run_id: str, session: Session = Depends(get_session)):
    run = _get_run_or_404(session, run_id)
    return serialize_run(run, _project_name(session, run.project_id))


TERMINAL_STATUSES = frozenset({"completed", "failed", "auth_expired", "canceled"})


@router.post("/runs/{run_id}/cancel", status_code=202)
def cancel_run(run_id: str, session: Session = Depends(get_session)):
    run = _get_run_or_404(session, run_id)
    if run.status in TERMINAL_STATUSES:
        raise ProblemException(
            409, "Run already finished",
            f"Run {run_id} is {run.status} and cannot be canceled",
        )
    from app.services.runner import kill_worker

    kill_worker(run.worker_pid)  # best-effort; never raises
    from datetime import datetime, timezone

    run.status = "canceled"
    run.ended_at = datetime.now(timezone.utc)
    run.detail = "canceled by user"
    session.commit()
    return {"run_id": run.id, "status": "canceled"}


@router.get("/runs/{run_id}/results")
def list_results(
    run_id: str,
    status: str | None = None,
    role: str | None = None,
    route: str | None = None,
    browser: str | None = None,
    flaky: bool | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    session: Session = Depends(get_session),
):
    """Return a bounded, filterable set of case results for one run."""
    _get_run_or_404(session, run_id)
    query = session.query(TestResult).filter_by(run_id=run_id)
    if status is not None:
        query = query.filter(TestResult.status == status)
    if role is not None:
        query = query.filter(TestResult.role == role)
    if route is not None:
        query = query.filter(TestResult.route_path == route)
    if browser is not None:
        query = query.filter(TestResult.browser == browser)
    if flaky is not None:
        query = query.filter(TestResult.flaky == flaky)
    rows = query.order_by(TestResult.id).limit(limit).all()
    return [serialize_result(row) for row in rows]


@router.get("/runs/{run_id}/bundles")
def get_bundles(
    run_id: str,
    severity_min: str = "low",
    include_flaky: bool = False,
    session: Session = Depends(get_session),
):
    _get_run_or_404(session, run_id)
    clusters = session.query(FailureCluster).filter_by(run_id=run_id).all()
    min_rank = SEVERITY_RANK.get(severity_min, 0)
    bundles = [
        c.bundle for c in clusters if SEVERITY_RANK.get(c.severity, 0) >= min_rank
    ]
    bundles.sort(
        key=lambda b: (-SEVERITY_RANK.get(b["severity"], 0), -b["occurrences"])
    )
    return bundles


@router.post("/runs/{run_id}/rerun", status_code=202)
def rerun_run(
    run_id: str,
    body: RerunBody,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    parent = _get_run_or_404(session, run_id)
    project = session.get(Project, parent.project_id) if parent.project_id else None
    base_url = body.base_url or parent.base_url

    requested_roles = parent.requested_roles
    browsers = parent.browsers
    viewports = parent.viewports
    if body.scope == "result":
        if body.result_id is None:
            raise ProblemException(
                400,
                "Result id required",
                "scope=result requires result_id",
            )
        target = session.get(TestResult, body.result_id)
        if target is None or target.run_id != run_id:
            raise ProblemException(
                404,
                "Result not found",
                f"No result {body.result_id!r} belongs to run {run_id}",
            )
        if not target.route_path:
            raise ProblemException(
                400,
                "Result is not rerunnable",
                "Suite results without a route cannot be retried individually",
            )
        routes = [target.route_path]
        requested_roles = [target.role] if target.role else parent.requested_roles
        browsers = [target.browser] if target.browser else parent.browsers
        viewports = [target.viewport] if target.viewport else parent.viewports
    elif body.scope in ("failed", "affected"):
        failed = (
            session.query(TestResult)
            .filter_by(run_id=run_id, status="failed", flaky=False)
            .all()
        )
        # suite tests carry route_path=None and cannot be re-targeted by route
        routes = sorted({r.route_path for r in failed if r.route_path})
        if not routes:
            raise ProblemException(
                400, "No rerunnable routes",
                "No failed results with a route in the parent run; use scope=full",
            )
    else:  # full
        routes = list(parent.requested_routes or [])

    if len(browsers or []) > 1 or len(viewports or []) > 1:
        raise ProblemException(
            409,
            "Execution matrix requires fan-out",
            "Retry one browser and viewport result at a time in Phase 1",
        )
    if project is None:
        project = _get_project_or_400(session, DEFAULT_PROJECT_NAME)
    new_run = create_run_row(
        session,
        settings,
        project,
        routes=routes,
        roles=requested_roles,
        base_url=base_url,
        app_version=body.app_version if body.app_version is not None else parent.app_version,
        trigger="manual",
        browsers=browsers,
        viewports=viewports,
        capture=parent.capture_config,
        parent_run_id=run_id,
        validate_routes=False,
    )

    return {"run_id": new_run.id, "status": "queued"}
