"""Pure scheduling logic: which projects are due to run right now.

Kept free of wall-clock access and I/O so it's trivially unit-testable with fixed
`now`/`last_scheduled_at` values. The FastAPI lifespan loop (app/main.py) is the
only caller that supplies a real clock and persists `last_scheduled_at`.
"""
from datetime import datetime, timezone
from typing import Any

from croniter import croniter


def _as_utc(dt: datetime) -> datetime:
    # SQLite returns naive datetimes; treat them as the UTC they were stored as
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def is_due(schedule_cron: str, anchor: datetime, now: datetime) -> bool:
    """True once the first cron boundary strictly after `anchor` has elapsed.

    `anchor` is the last scheduled time, or — for a project that has never run — its
    creation time. Anchoring at creation is the v0.3 fix: a newly-created project fires
    at its next real cron boundary rather than catch-up-firing on the next tick.
    """
    next_fire = croniter(schedule_cron, _as_utc(anchor)).get_next(datetime)
    return next_fire <= now


def projects_due(projects: list[Any], now: datetime) -> list[Any]:
    """Filter `projects` down to those whose next cron boundary has elapsed since they
    were last scheduled (or created, if never scheduled)."""
    due = []
    for project in projects:
        if not getattr(project, "enabled", True):
            continue
        cron = getattr(project, "schedule_cron", None)
        if not cron:
            continue
        anchor = getattr(project, "last_scheduled_at", None) or getattr(project, "created_at", None) or now
        try:
            if is_due(cron, anchor, now):
                due.append(project)
        except (ValueError, KeyError):
            continue  # malformed cron expression - skip rather than crash the loop
    return due
