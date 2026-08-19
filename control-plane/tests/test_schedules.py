"""Dedicated schedule API contract over the durable project scheduler fields."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier

from app.api.runs import create_run_row
from app.db import Project
from app.main import _scheduler_tick
from app.problems import ProblemException
from app.services.schedule_execution import ScheduleOverlapError, trigger_scheduled_run


def test_schedule_lifecycle_and_history(client):
    created = client.put(
        "/api/v1/schedules/default",
        json={"cron": "*/15 * * * *", "enabled": True},
    )
    assert created.status_code == 200, created.text
    schedule = created.json()
    assert schedule["id"].startswith("sched_")
    assert schedule["project"] == "default"
    assert schedule["cron"] == "*/15 * * * *"
    assert schedule["timezone"] == "UTC"
    assert schedule["overlap_policy"] == "skip"
    assert schedule["enabled"] is True
    assert schedule["next_run_at"] is not None
    assert client.get(f"/api/v1/schedules/{schedule['id']}").status_code == 200

    listed = client.get("/api/v1/schedules").json()
    assert [row["project"] for row in listed] == ["default"]
    assert client.get("/api/v1/schedules/default").json()["cron"] == "*/15 * * * *"

    updated = client.patch(
        "/api/v1/schedules/default", json={"cron": "0 * * * *"}
    )
    assert updated.status_code == 200
    assert updated.json()["cron"] == "0 * * * *"

    paused = client.post("/api/v1/schedules/default/pause")
    assert paused.status_code == 200
    assert paused.json()["enabled"] is False
    assert paused.json()["next_run_at"] is None

    resumed = client.post("/api/v1/schedules/default/resume")
    assert resumed.status_code == 200
    assert resumed.json()["enabled"] is True

    fired = client.post("/api/v1/schedules/default/run")
    assert fired.status_code == 202, fired.text
    run_id = fired.json()["run_id"]

    duplicate = client.post("/api/v1/schedules/default/run")
    assert duplicate.status_code == 409
    assert "active run" in duplicate.json()["detail"]

    history = client.get("/api/v1/schedules/default/history").json()
    assert history[0]["id"] == run_id
    assert history[0]["trigger"] == "schedule"

    deleted = client.delete("/api/v1/schedules/default")
    assert deleted.json() == {"project": "default", "deleted": True}
    assert client.get("/api/v1/schedules/default").status_code == 404


async def test_new_schedule_starts_at_next_advertised_boundary(client, app):
    with app.state.SessionLocal() as session:
        project = session.query(Project).filter_by(name="default").one()
        project.created_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
        project.last_scheduled_at = None
        session.commit()

    response = client.put(
        "/api/v1/schedules/default",
        json={"cron": "0 0 * * *", "enabled": True},
    )
    schedule = response.json()
    assert schedule["last_scheduled_at"] is not None
    next_run = datetime.fromisoformat(schedule["next_run_at"])

    await _scheduler_tick(app, now=next_run - timedelta(seconds=1))
    default_runs = [
        run for run in client.get("/api/v1/runs").json() if run["project"] == "default"
    ]
    assert default_runs == []


def test_concurrent_schedule_fires_create_only_one_run(app, settings, client):
    client.put(
        "/api/v1/schedules/default",
        json={"cron": "0 * * * *", "enabled": True},
    )
    with app.state.SessionLocal() as session:
        project_id = session.query(Project).filter_by(name="default").one().id

    barrier = Barrier(2)
    now = datetime.now(timezone.utc)

    def fire() -> str:
        with app.state.SessionLocal() as session:
            barrier.wait()
            try:
                trigger_scheduled_run(
                    session,
                    settings,
                    project_id,
                    now=now,
                    advance_anchor_on_overlap=False,
                )
                return "created"
            except ScheduleOverlapError:
                return "overlap"

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(fire) for _ in range(2)]
        outcomes = sorted(future.result() for future in futures)

    assert outcomes == ["created", "overlap"]


def test_schedule_and_manual_race_create_only_one_active_run(app, settings, client):
    client.put(
        "/api/v1/schedules/default",
        json={"cron": "0 * * * *", "enabled": True},
    )
    with app.state.SessionLocal() as session:
        project_id = session.query(Project).filter_by(name="default").one().id

    barrier = Barrier(2)
    now = datetime.now(timezone.utc)

    def fire_schedule() -> str:
        with app.state.SessionLocal() as session:
            barrier.wait()
            try:
                trigger_scheduled_run(
                    session,
                    settings,
                    project_id,
                    now=now,
                    advance_anchor_on_overlap=False,
                )
                return "schedule-created"
            except ScheduleOverlapError:
                return "schedule-blocked"

    def fire_manual() -> str:
        with app.state.SessionLocal() as session:
            project = session.get(Project, project_id)
            barrier.wait()
            try:
                create_run_row(
                    session,
                    settings,
                    project,
                    routes=["/"],
                    trigger="manual",
                )
                return "manual-created"
            except ProblemException:
                return "manual-blocked"

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(fire_schedule), pool.submit(fire_manual)]
        outcomes = [future.result() for future in futures]

    assert sum(outcome.endswith("created") for outcome in outcomes) == 1
    assert sum(outcome.endswith("blocked") for outcome in outcomes) == 1
    active = [
        run
        for run in client.get("/api/v1/runs").json()
        if run["status"] in ("queued", "running")
    ]
    assert len(active) == 1


def test_schedule_rejects_invalid_cron(client):
    response = client.put(
        "/api/v1/schedules/default", json={"cron": "not a cron", "enabled": True}
    )
    assert response.status_code == 400
    assert response.json()["title"] == "Invalid cron expression"


def test_schedule_requires_existing_project(client):
    response = client.put(
        "/api/v1/schedules/missing", json={"cron": "0 * * * *", "enabled": True}
    )
    assert response.status_code == 404


def test_schedule_get_requires_existing_schedule(client):
    response = client.get("/api/v1/schedules/default")
    assert response.status_code == 404
    assert response.json()["title"] == "Schedule not found"
