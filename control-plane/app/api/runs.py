from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import FailureCluster, Project, Route, TestResult, TestRun
from app.deps import get_session, get_settings, require_auth
from app.ids import new_id
from app.problems import ProblemException
from app.serializers import serialize_result, serialize_run
from app.services.discovery import DEFAULT_PROJECT_NAME
from app.services.runner import maybe_spawn
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


class RerunBody(BaseModel):
    scope: Literal["failed", "affected", "full"]
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
    base_url = body.base_url or project.base_url_default

    if body.routes != ["ALL"]:
        known_paths = {
            r.path for r in session.query(Route).filter_by(project_id=project.id).all()
        }
        for path in body.routes:
            if path not in known_paths:
                raise ProblemException(
                    400, "Unknown route", f"Unknown route for {project.name}: {path}"
                )

    run_id = new_id("run")
    run = TestRun(
        id=run_id,
        project_id=project.id,
        trigger="manual",
        base_url=base_url,
        app_version=body.app_version,
        requested_routes=body.routes,
        requested_roles=body.roles or [],
        browsers=body.browsers or [],
        viewports=body.viewports or [],
        capture_config=body.capture or {},
        idempotency_key=idem_key,
        parent_run_id=None,
        started_at=None,
        ended_at=None,
        status="queued",
        totals=None,
        detail=None,
    )
    session.add(run)
    session.commit()

    maybe_spawn(run, project, settings)

    return {"run_id": run_id, "status": "queued"}


@router.get("/runs")
def list_runs(session: Session = Depends(get_session)):
    rows = session.query(TestRun).order_by(TestRun.id).all()
    return [serialize_run(r, _project_name(session, r.project_id)) for r in rows]


@router.get("/runs/{run_id}")
def get_run(run_id: str, session: Session = Depends(get_session)):
    run = _get_run_or_404(session, run_id)
    return serialize_run(run, _project_name(session, run.project_id))


@router.get("/runs/{run_id}/results")
def list_results(run_id: str, session: Session = Depends(get_session)):
    _get_run_or_404(session, run_id)
    rows = session.query(TestResult).filter_by(run_id=run_id).order_by(TestResult.id).all()
    return [serialize_result(r) for r in rows]


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

    if body.scope in ("failed", "affected"):
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

    new_run_id = new_id("run")
    new_run = TestRun(
        id=new_run_id,
        project_id=parent.project_id,
        trigger="manual",
        base_url=base_url,
        app_version=body.app_version if body.app_version is not None else parent.app_version,
        requested_routes=routes,
        requested_roles=parent.requested_roles,
        browsers=parent.browsers,
        viewports=parent.viewports,
        capture_config=parent.capture_config,
        idempotency_key=None,
        parent_run_id=run_id,
        started_at=None,
        ended_at=None,
        status="queued",
        totals=None,
        detail=None,
    )
    session.add(new_run)
    session.commit()

    if project is None:
        project = _get_project_or_400(session, DEFAULT_PROJECT_NAME)
    maybe_spawn(new_run, project, settings)

    return {"run_id": new_run_id, "status": "queued"}
