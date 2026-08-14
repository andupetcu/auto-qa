"""Serialized scheduled-run creation for the single-process v0.x control plane."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.api.runs import create_run_row
from app.db import Project, TestRun
from app.services.project_run_lock import project_run_lock
from app.settings import Settings

_ACTIVE_RUN_STATUSES = ("queued", "running")


class SchedulePausedError(RuntimeError):
    """Raised when a paused project schedule is fired manually."""


class ScheduleOverlapError(RuntimeError):
    """Raised when overlap policy skips a fire because another run is active."""

    def __init__(self, active_run_id: str):
        super().__init__(active_run_id)
        self.active_run_id = active_run_id


def trigger_scheduled_run(
    session: Session,
    settings: Settings,
    project_id: str,
    *,
    now: datetime,
    advance_anchor_on_overlap: bool,
) -> TestRun:
    """Atomically apply pause/overlap policy and create one scheduled run.

    The lock is process-local by design: Auto QA v0.x runs exactly one control-plane
    process. Moving to multiple workers requires a database-backed advisory lock.
    """
    with project_run_lock(project_id):
        session.expire_all()
        project = session.get(Project, project_id)
        if project is None:
            raise LookupError(project_id)
        if not project.enabled:
            raise SchedulePausedError(project.name)

        active = (
            session.query(TestRun)
            .filter(
                TestRun.project_id == project.id,
                TestRun.status.in_(_ACTIVE_RUN_STATUSES),
            )
            .order_by(TestRun.id)
            .first()
        )
        if active is not None:
            if advance_anchor_on_overlap:
                project.last_scheduled_at = now
                session.commit()
            raise ScheduleOverlapError(active.id)

        run = create_run_row(
            session,
            settings,
            project,
            routes=["ALL"],
            roles=[role["name"] for role in (project.roles or [])],
            trigger="schedule",
        )
        project.last_scheduled_at = now
        session.commit()
        return run
