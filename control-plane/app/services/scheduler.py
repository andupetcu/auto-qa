"""Pure scheduling logic: which projects are due to run right now.

Kept free of wall-clock access and I/O so it's trivially unit-testable with fixed
`now`/`last_scheduled_at` values. The FastAPI lifespan loop (app/main.py) is the
only caller that supplies a real clock and persists `last_scheduled_at`.
"""
from datetime import datetime
from typing import Any

from croniter import croniter


def is_due(schedule_cron: str, last_scheduled_at: datetime | None, now: datetime) -> bool:
    """True if the cron has fired at least once in (last_scheduled_at, now]."""
    prev_fire = croniter(schedule_cron, now).get_prev(datetime)
    if prev_fire > now:
        return False
    if last_scheduled_at is None:
        return True
    return prev_fire > last_scheduled_at


def projects_due(projects: list[Any], now: datetime) -> list[Any]:
    """Filter `projects` (anything with .enabled/.schedule_cron/.last_scheduled_at) down
    to those whose cron has fired since they were last scheduled."""
    due = []
    for project in projects:
        if not getattr(project, "enabled", True):
            continue
        cron = getattr(project, "schedule_cron", None)
        if not cron:
            continue
        last = getattr(project, "last_scheduled_at", None)
        try:
            if is_due(cron, last, now):
                due.append(project)
        except (ValueError, KeyError):
            continue  # malformed cron expression - skip rather than crash the loop
    return due
