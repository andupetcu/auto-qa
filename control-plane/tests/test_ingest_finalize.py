from pathlib import Path
import zipfile

import pytest

from conftest import create_run, finalize, ingest, result_payload, sig_input


def test_ingest_finalize_totals(client):
    rid = create_run(client)
    ingest(client, rid, [
        result_payload("passed"),
        result_payload("failed", route="/campaigns/reports",
                       signature_input=sig_input(route="/campaigns/reports")),
        result_payload("failed", route="/campaigns/campaign-library", flaky=True,
                       reruns_attempted=3, reruns_failed=1),
    ])
    finalize(client, rid)
    run = client.get(f"/api/v1/runs/{rid}").json()
    assert run["status"] == "completed"
    assert run["ended_at"] is not None
    assert run["totals"] == {"passed": 1, "failed": 1, "skipped": 0, "flaky": 1}


def test_ingest_accepts_null_route_path_for_suite_tests(client):
    rid = create_run(client)
    ingest(client, rid, [
        result_payload("passed", route=None, role="user",
                       test_name="reports deeplink renders"),
    ])
    finalize(client, rid)
    results = client.get(f"/api/v1/runs/{rid}/results").json()["items"]
    assert results[0]["route_path"] is None


def test_started_marks_running(client):
    rid = create_run(client)
    r = client.post(f"/api/v1/internal/runs/{rid}/started")
    assert r.status_code == 200
    run = client.get(f"/api/v1/runs/{rid}").json()
    assert run["status"] == "running"
    assert run["started_at"] is not None


@pytest.mark.parametrize("terminal_status", ["completed", "failed", "auth_expired"])
def test_late_started_and_ingest_cannot_resurrect_terminal_run(client, terminal_status):
    rid = create_run(client)
    finalize(client, rid, status=terminal_status)
    started = client.post(f"/api/v1/internal/runs/{rid}/started")
    ingestion = client.post(
        f"/api/v1/internal/runs/{rid}/results",
        json=[result_payload("passed")],
    )
    assert started.status_code == 200
    assert started.json()["status"] == terminal_status
    assert ingestion.status_code == 409
    assert client.get(f"/api/v1/runs/{rid}").json()["status"] == terminal_status
    assert client.get(f"/api/v1/runs/{rid}/results").json()["items"] == []


def test_finalize_auth_expired(client):
    rid = create_run(client)
    finalize(client, rid, status="auth_expired", detail="session stale")
    assert client.get(f"/api/v1/runs/{rid}").json()["status"] == "auth_expired"


def test_results_listing_and_artifact_rows(client, settings):
    rid = create_run(client)
    storage_key = f"runs/{rid}/t1/trace.zip"
    artifact_path = Path(settings.artifacts_dir) / storage_key
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(artifact_path, "w") as archive:
        archive.writestr("trace.json", '{"event":"safe"}')
    ingest(client, rid, [
        result_payload("failed", signature_input=sig_input(),
                       artifacts=[{"type": "trace",
                                   "storage_key": storage_key,
                                   "bytes": artifact_path.stat().st_size}]),
    ])
    finalize(client, rid)
    results = client.get(f"/api/v1/runs/{rid}/results").json()["items"]
    assert len(results) == 1
    res = results[0]
    assert res["id"].startswith("res_")
    assert res["status"] == "failed"
    arts = client.get(f"/api/v1/results/{res['id']}/artifacts").json()
    assert len(arts) == 1
    assert arts[0]["type"] == "trace"
    assert "sig=" in arts[0]["url"] and "exp=" in arts[0]["url"]
    assert arts[0]["expires_at"]
