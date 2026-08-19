from conftest import create_run, finalize, result_payload


def test_progress_defaults_null(client):
    rid = create_run(client)
    run = client.get(f"/api/v1/runs/{rid}").json()
    assert run["progress"] is None


def test_progress_updates_merge(client):
    rid = create_run(client)
    r1 = client.post(f"/api/v1/internal/runs/{rid}/progress",
                     json={"phase": "running", "done": 0, "total": 8})
    assert r1.status_code == 200
    client.post(f"/api/v1/internal/runs/{rid}/progress",
                json={"done": 3, "current": "matrix / as user -> render"})
    prog = client.get(f"/api/v1/runs/{rid}").json()["progress"]
    assert prog["phase"] == "running"        # preserved from the first update
    assert prog["done"] == 3
    assert prog["total"] == 8
    assert prog["current"] == "matrix / as user -> render"
    assert prog["updated_at"]


def test_cancel_running_run(client):
    rid = create_run(client)
    client.post(f"/api/v1/internal/runs/{rid}/started")
    r = client.post(f"/api/v1/runs/{rid}/cancel")
    assert r.status_code == 202
    assert r.json()["status"] == "canceled"
    run = client.get(f"/api/v1/runs/{rid}").json()
    assert run["status"] == "canceled"
    assert run["ended_at"] is not None


def test_cancel_queued_run(client):
    rid = create_run(client)
    assert client.post(f"/api/v1/runs/{rid}/cancel").status_code == 202
    assert client.get(f"/api/v1/runs/{rid}").json()["status"] == "canceled"


def test_cancel_finished_run_is_409(client):
    rid = create_run(client)
    finalize(client, rid, status="completed")
    r = client.post(f"/api/v1/runs/{rid}/cancel")
    assert r.status_code == 409
    assert r.headers["content-type"].startswith("application/problem+json")


def test_late_worker_callbacks_are_rejected_after_cancel(client):
    # A worker killed mid-run must not resurrect or append to a canceled run.
    rid = create_run(client)
    client.post(f"/api/v1/internal/runs/{rid}/started")
    client.post(f"/api/v1/runs/{rid}/cancel")
    started = client.post(f"/api/v1/internal/runs/{rid}/started")
    ingestion = client.post(
        f"/api/v1/internal/runs/{rid}/results", json=[result_payload("passed")]
    )
    finalized = client.post(
        f"/api/v1/internal/runs/{rid}/finalize", json={"status": "completed"}
    )
    assert started.status_code == 200
    assert started.json()["status"] == "canceled"
    assert ingestion.status_code == 409
    assert finalized.status_code == 200
    assert client.get(f"/api/v1/runs/{rid}").json()["status"] == "canceled"
    assert client.get(f"/api/v1/runs/{rid}/results").json()["items"] == []


def test_progress_ignored_after_terminal(client):
    rid = create_run(client)
    finalize(client, rid, status="completed")
    client.post(f"/api/v1/internal/runs/{rid}/progress", json={"phase": "running"})
    assert client.get(f"/api/v1/runs/{rid}").json()["progress"] is None


def test_cancel_missing_run_404(client):
    r = client.post("/api/v1/runs/run_00000000000000000000000000/cancel")
    assert r.status_code == 404
