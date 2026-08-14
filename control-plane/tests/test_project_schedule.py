from datetime import datetime, timezone


def test_create_project_with_schedule_fields(client):
    body = {
        "name": "scheduled",
        "base_url_default": "https://scheduled.example.test",
        "schedule_cron": "0 * * * *",
        "max_parallel": 4,
        "enabled": False,
    }
    r = client.post("/api/v1/projects", json=body)
    assert r.status_code == 201, r.text
    p = r.json()
    assert p["schedule_cron"] == "0 * * * *"
    assert p["max_parallel"] == 4
    assert p["enabled"] is False
    assert p["next_run_at"] is None  # disabled projects don't get a next_run_at... see below


def test_default_project_has_schedule_defaults(client):
    fai = client.get("/api/v1/projects/fai").json()
    assert fai["enabled"] is True
    assert fai["max_parallel"] == 2
    assert fai["schedule_cron"] is None
    assert fai["next_run_at"] is None
    assert fai["credentials"] == {"username": None, "has_password": False, "has_totp": False}


def test_next_run_at_present_when_cron_set(client):
    body = {
        "name": "cronproj",
        "base_url_default": "https://cron.example.test",
        "schedule_cron": "*/5 * * * *",
    }
    r = client.post("/api/v1/projects", json=body)
    p = r.json()
    assert p["next_run_at"] is not None
    next_run = datetime.fromisoformat(p["next_run_at"])
    assert next_run.tzinfo is not None
    assert next_run > datetime.now(timezone.utc)


def test_patch_enabled_false(client):
    client.post("/api/v1/projects", json={
        "name": "togglable", "base_url_default": "https://x.test",
        "schedule_cron": "*/5 * * * *",
    })
    r = client.patch("/api/v1/projects/togglable", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    # a disabled project should not surface a next_run_at
    assert r.json()["next_run_at"] is None
