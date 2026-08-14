"""GET /matrix: route x role expectations vs actuals.

expectations come from project.role_matrix (falling back to browser-worker's
role-matrix.yaml for the default `fai` project only, when role_matrix is empty).
actuals come from the most recent per-(route, role) test_result status in the
project's latest COMPLETED run.
"""
import yaml
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import Project, Route, TestResult, TestRun
from app.deps import get_session, get_settings, require_auth
from app.problems import ProblemException
from app.services.discovery import DEFAULT_PROJECT_NAME
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


def _load_yaml_role_matrix(path: str) -> dict:
    try:
        with open(path) as f:
            data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}
    return data


def _expectations_for(project: Project, settings: Settings) -> dict:
    if project.role_matrix:
        return project.role_matrix
    if project.name == DEFAULT_PROJECT_NAME:
        return _load_yaml_role_matrix(settings.role_matrix_fallback_path)
    return {}


def _latest_completed_run(session: Session, project_id: str) -> TestRun | None:
    return (
        session.query(TestRun)
        .filter_by(project_id=project_id, status="completed")
        .order_by(TestRun.id.desc())
        .first()
    )


def _actuals_by_path(session: Session, run_id: str) -> dict:
    rows = session.query(TestResult).filter_by(run_id=run_id).order_by(TestResult.id).all()
    actuals: dict[str, dict] = {}
    for row in rows:
        if row.route_path is None or row.role is None:
            continue
        # ULIDs sort ascending, so a later row for the same (path, role) overwrites
        # the earlier one — this naturally yields the *most recent* status.
        actuals.setdefault(row.route_path, {})[row.role] = row.status
    return actuals


@router.get("/matrix")
def get_matrix(
    project: str = DEFAULT_PROJECT_NAME,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    proj = session.query(Project).filter_by(name=project).first()
    if proj is None:
        raise ProblemException(404, "Project not found", f"No project named {project}")

    expectations = _expectations_for(proj, settings)

    routes = session.query(Route).filter_by(project_id=proj.id).order_by(Route.id).all()
    source_by_path = {r.path: r.discovery_source for r in routes}
    paths = [r.path for r in routes]
    for path in expectations:
        if path not in source_by_path:
            paths.append(path)
            source_by_path[path] = "role_matrix"

    latest_run = _latest_completed_run(session, proj.id)
    actuals = _actuals_by_path(session, latest_run.id) if latest_run else {}

    result = []
    for path in paths:
        exp = expectations.get(path, {})
        act_for_path = actuals.get(path, {})
        result.append({
            "path": path,
            "source": source_by_path.get(path, "unknown"),
            "expectations": exp,
            "actuals": {role: act_for_path.get(role) for role in exp},
        })
    return result
