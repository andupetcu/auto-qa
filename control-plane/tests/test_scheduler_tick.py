"""End-to-end verification that the scheduler tick fires a due project exactly once
and does not double-fire on subsequent ticks (before the next cron boundary), including
after the triggered run has completed."""
from datetime import datetime, timedelta, timezone

from conftest import create_run
from app.main import _scheduler_tick


def _make_due_project(client, cron="* * * * *"):
    p = client.post("/api/v1/projects", json={
        "name": "sched", "base_url_default": "https://s.test",
        "routes": ["/"], "schedule_cron": cron,
    }).json()
    return p


def _runs_for(client, project_name):
    return [r for r in client.get("/api/v1/runs").json() if r["project"] == project_name]


async def _backdate_schedule_anchor(app, project_name, when):
    from app.db import Project

    with app.state.SessionLocal() as session:
        proj = session.query(Project).filter_by(name=project_name).one()
        proj.created_at = when
        proj.last_scheduled_at = when
        session.commit()


async def test_tick_fires_once_then_not_again_within_boundary(client, app):
    # hourly cron so several ticks (and a run completion) stay inside one :00 boundary
    _make_due_project(client, cron="0 * * * *")
    await _backdate_schedule_anchor(app, "sched", datetime(2026, 8, 14, 11, 30, tzinfo=timezone.utc))
    t0 = datetime(2026, 8, 14, 12, 0, 30, tzinfo=timezone.utc)  # just past the 12:00 fire

    await _scheduler_tick(app, now=t0)
    assert len(_runs_for(client, "sched")) == 1, "first tick should fire exactly one run"

    # subsequent ticks in the same hour must NOT fire again
    await _scheduler_tick(app, now=t0 + timedelta(minutes=5))
    assert len(_runs_for(client, "sched")) == 1, "must not double-fire before next boundary"

    # completing the triggered run must not re-arm the scheduler
    run_id = _runs_for(client, "sched")[0]["id"]
    client.post(f"/api/v1/internal/runs/{run_id}/finalize", json={"status": "completed"})
    await _scheduler_tick(app, now=t0 + timedelta(minutes=30))
    assert len(_runs_for(client, "sched")) == 1, "completion must not re-arm the scheduler"


async def test_tick_fires_again_after_next_boundary(client, app):
    _make_due_project(client, cron="0 * * * *")
    await _backdate_schedule_anchor(app, "sched", datetime(2026, 8, 14, 11, 30, tzinfo=timezone.utc))
    t0 = datetime(2026, 8, 14, 12, 0, 30, tzinfo=timezone.utc)

    await _scheduler_tick(app, now=t0)
    first_run_id = _runs_for(client, "sched")[0]["id"]
    client.post(
        f"/api/v1/internal/runs/{first_run_id}/finalize",
        json={"status": "completed"},
    )
    await _scheduler_tick(app, now=t0 + timedelta(hours=1))  # next :00 boundary passed
    assert len(_runs_for(client, "sched")) == 2, "should fire once per elapsed boundary"


async def test_tick_skips_overlap_while_project_has_active_run(client, app):
    _make_due_project(client, cron="0 * * * *")
    create_run(client, project="sched")
    await _backdate_schedule_anchor(
        app, "sched", datetime(2026, 8, 14, 11, 30, tzinfo=timezone.utc)
    )

    await _scheduler_tick(
        app, now=datetime(2026, 8, 14, 12, 0, 30, tzinfo=timezone.utc)
    )

    runs = _runs_for(client, "sched")
    assert len(runs) == 1
    assert runs[0]["trigger"] == "manual"

    client.post(
        f"/api/v1/internal/runs/{runs[0]['id']}/finalize",
        json={"status": "completed"},
    )
    await _scheduler_tick(
        app, now=datetime(2026, 8, 14, 12, 30, tzinfo=timezone.utc)
    )
    assert len(_runs_for(client, "sched")) == 1, "skipped boundary must not replay"


async def test_disabled_project_never_fires(client, app):
    _make_due_project(client, cron="* * * * *")
    client.patch("/api/v1/projects/sched", json={"enabled": False})
    await _scheduler_tick(app, now=datetime(2026, 8, 14, 12, 5, tzinfo=timezone.utc))
    assert _runs_for(client, "sched") == []
