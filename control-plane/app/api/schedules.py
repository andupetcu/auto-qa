"""Durable one-schedule-per-project operator API for the v0.2 scheduler contract."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.projects import (
    _next_run_at,
    _validate_schedule_cron,
    get_project_by_id_or_name,
)
from app.db import Project, TestRun
from app.deps import get_session, get_settings, require_auth
from app.problems import ProblemException
from app.serializers import serialize_run
from app.services.schedule_execution import (
    ScheduleOverlapError,
    SchedulePausedError,
    trigger_scheduled_run,
)
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


class SchedulePut(BaseModel):
    cron: str
    enabled: bool = True


class SchedulePatch(BaseModel):
    cron: str | None = None
    enabled: bool | None = None


def _schedule_id(project: Project) -> str:
    suffix = project.id.removeprefix("prj_")
    return f"sched_{suffix}"


def _get_schedule_project(session: Session, id_or_name: str) -> Project:
    project_ref = (
        f"prj_{id_or_name.removeprefix('sched_')}"
        if id_or_name.startswith("sched_")
        else id_or_name
    )
    return get_project_by_id_or_name(session, project_ref)


def _require_schedule(project: Project) -> None:
    if not project.schedule_cron:
        raise ProblemException(
            404,
            "Schedule not found",
            f"Project {project.name!r} does not have a schedule",
        )


def _serialize(project: Project) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "id": _schedule_id(project),
        "project": project.name,
        "cron": project.schedule_cron,
        "timezone": "UTC",
        "enabled": bool(project.enabled),
        "overlap_policy": "skip",
        "last_scheduled_at": (
            project.last_scheduled_at.isoformat()
            if project.last_scheduled_at is not None
            else None
        ),
        "next_run_at": _next_run_at(project, now),
    }


@router.get("/schedules")
def list_schedules(session: Session = Depends(get_session)):
    projects = (
        session.query(Project)
        .filter(Project.schedule_cron.is_not(None))
        .order_by(Project.name)
        .all()
    )
    return [_serialize(project) for project in projects]


@router.get("/schedules/{id_or_name}")
def get_schedule(id_or_name: str, session: Session = Depends(get_session)):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    return _serialize(project)


@router.put("/schedules/{id_or_name}")
def put_schedule(
    id_or_name: str,
    body: SchedulePut,
    session: Session = Depends(get_session),
):
    project = _get_schedule_project(session, id_or_name)
    _validate_schedule_cron(body.cron)
    project.schedule_cron = body.cron
    project.enabled = body.enabled
    project.last_scheduled_at = datetime.now(timezone.utc)
    session.commit()
    return _serialize(project)


@router.patch("/schedules/{id_or_name}")
def patch_schedule(
    id_or_name: str,
    body: SchedulePatch,
    session: Session = Depends(get_session),
):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    if body.cron is not None:
        _validate_schedule_cron(body.cron)
        project.schedule_cron = body.cron
        project.last_scheduled_at = datetime.now(timezone.utc)
    if body.enabled is not None:
        project.enabled = body.enabled
    session.commit()
    return _serialize(project)


@router.delete("/schedules/{id_or_name}")
def delete_schedule(id_or_name: str, session: Session = Depends(get_session)):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    project.schedule_cron = None
    project.last_scheduled_at = None
    session.commit()
    return {"project": project.name, "deleted": True}


@router.post("/schedules/{id_or_name}/pause")
def pause_schedule(id_or_name: str, session: Session = Depends(get_session)):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    project.enabled = False
    session.commit()
    return _serialize(project)


@router.post("/schedules/{id_or_name}/resume")
def resume_schedule(id_or_name: str, session: Session = Depends(get_session)):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    project.enabled = True
    project.last_scheduled_at = datetime.now(timezone.utc)
    session.commit()
    return _serialize(project)


@router.post("/schedules/{id_or_name}/run", status_code=202)
def run_schedule_now(
    id_or_name: str,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    now = datetime.now(timezone.utc)
    try:
        run = trigger_scheduled_run(
            session,
            settings,
            project.id,
            now=now,
            advance_anchor_on_overlap=False,
        )
    except SchedulePausedError as exc:
        raise ProblemException(
            409,
            "Schedule paused",
            f"Schedule for project {project.name!r} is paused",
        ) from exc
    except ScheduleOverlapError as exc:
        raise ProblemException(
            409,
            "Schedule overlap skipped",
            f"Project {project.name!r} already has active run {exc.active_run_id}",
        ) from exc
    return {"run_id": run.id, "status": run.status}


@router.get("/schedules/{id_or_name}/history")
def get_schedule_history(
    id_or_name: str,
    limit: int = Query(default=50, ge=1, le=200),
    session: Session = Depends(get_session),
):
    project = _get_schedule_project(session, id_or_name)
    _require_schedule(project)
    rows = (
        session.query(TestRun)
        .filter(TestRun.project_id == project.id, TestRun.trigger == "schedule")
        .order_by(TestRun.id.desc())
        .limit(limit)
        .all()
    )
    return [serialize_run(row, project.name) for row in rows]
