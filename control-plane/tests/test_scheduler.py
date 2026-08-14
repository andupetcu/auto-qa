"""Unit tests for the pure `projects_due` scheduling function - no wall clock,
no DB, no asyncio: just plain objects with .enabled/.schedule_cron/.last_scheduled_at."""
from datetime import datetime, timezone
from types import SimpleNamespace

from app.services.scheduler import projects_due


def _project(**kw):
    defaults = dict(
        name="p", enabled=True, schedule_cron=None, last_scheduled_at=None,
    )
    defaults.update(kw)
    return SimpleNamespace(**defaults)


def test_disabled_project_never_due():
    now = datetime(2026, 8, 14, 12, 0, tzinfo=timezone.utc)
    p = _project(enabled=False, schedule_cron="* * * * *", last_scheduled_at=None)
    assert projects_due([p], now) == []


def test_no_cron_never_due():
    now = datetime(2026, 8, 14, 12, 0, tzinfo=timezone.utc)
    p = _project(schedule_cron=None)
    assert projects_due([p], now) == []


def test_due_when_never_scheduled_and_cron_fire_in_past():
    # hourly cron, last fire was at 12:00, now is 12:05 -> due (never run before)
    now = datetime(2026, 8, 14, 12, 5, tzinfo=timezone.utc)
    p = _project(schedule_cron="0 * * * *", last_scheduled_at=None)
    assert projects_due([p], now) == [p]


def test_not_due_again_before_next_fire():
    # last_scheduled_at is after the most recent fire -> not due yet
    now = datetime(2026, 8, 14, 12, 5, tzinfo=timezone.utc)
    last = datetime(2026, 8, 14, 12, 1, tzinfo=timezone.utc)
    p = _project(schedule_cron="0 * * * *", last_scheduled_at=last)
    assert projects_due([p], now) == []


def test_due_again_after_next_fire_has_passed():
    # last run was at the 12:00 fire; now it's 13:02, past the 13:00 fire -> due
    now = datetime(2026, 8, 14, 13, 2, tzinfo=timezone.utc)
    last = datetime(2026, 8, 14, 12, 0, tzinfo=timezone.utc)
    p = _project(schedule_cron="0 * * * *", last_scheduled_at=last)
    assert projects_due([p], now) == [p]


def test_mixed_batch_only_returns_due_projects():
    now = datetime(2026, 8, 14, 13, 2, tzinfo=timezone.utc)
    due = _project(name="due", schedule_cron="0 * * * *",
                    last_scheduled_at=datetime(2026, 8, 14, 12, 0, tzinfo=timezone.utc))
    not_due = _project(name="not_due", schedule_cron="0 * * * *",
                        last_scheduled_at=datetime(2026, 8, 14, 13, 0, tzinfo=timezone.utc))
    disabled = _project(name="disabled", enabled=False, schedule_cron="* * * * *")
    no_cron = _project(name="no_cron", schedule_cron=None)
    result = projects_due([due, not_due, disabled, no_cron], now)
    assert result == [due]
