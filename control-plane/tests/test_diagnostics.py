"""Public diagnostics, collector-health, and readiness projection contracts."""

import json
from pathlib import Path

from conftest import create_run, ingest, result_payload


def _diagnostic_result(client, settings):
    run_id = create_run(client)
    root = Path(settings.artifacts_dir) / "runs" / run_id / "diagnostics"
    root.mkdir(parents=True, exist_ok=True)
    console_path = root / "console.jsonl"
    console_path.write_text('{"level":"error","kind":"pageerror","text":"safe failure"}\n')
    manifest_path = root / "visual-manifest.json"
    manifest_path.write_text(json.dumps({
        "schemaVersion": 2,
        "resultId": None,
        "resultKey": "diagnostics",
        "route": "/resolved/deep-link?token=secret#section",
        "role": "user",
        "browser": "chromium",
        "viewport": "1440x900",
        "capturePolicyVersion": 1,
        "evidenceState": "captured_settled",
        "readiness": {
            "status": "passed",
            "policyVersion": 1,
            "elapsedMs": 1200,
            "pendingCriticalRequests": 0,
            "visibleLoadingSelectors": [],
            "reasons": [],
            "networkFailures": [],
            "runtimeErrors": [],
        },
        "frames": [],
        "finalScreenshot": None,
        "contactSheet": None,
        "warnings": [],
    }))
    network = [
        {
            "kind": "summary",
            "collector_status": "completed",
            "total_entries": 4,
            "status_counts": {"200": 3, "-1": 1},
            "pending": 1,
            "request_failures": 0,
            "http_4xx": 0,
            "http_5xx": 0,
            "slow": 0,
        },
        {
            "kind": "pending",
            "method": "POST",
            "url_path": "/api/chart",
            "status": -1,
            "timing_ms": -1,
            "resp_snippet": "",
        },
    ]
    ingest(client, run_id, [result_payload(
        "passed",
        route="/resolved/deep-link?token=secret#section",
        console_summary=[{"level": "error", "kind": "pageerror", "text": "safe failure"}],
        network_summary=network,
        artifacts=[
            {"type": "console", "storage_key": str(console_path.relative_to(settings.artifacts_dir))},
            {"type": "visual_manifest", "storage_key": str(manifest_path.relative_to(settings.artifacts_dir))},
        ],
    )])
    return run_id, client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0]["id"]


def test_diagnostics_distinguish_collector_health_from_event_count(client, settings):
    run_id, result_id = _diagnostic_result(client, settings)
    stored = client.get(f"/api/v1/runs/{run_id}/results").json()["items"]
    assert stored[0]["route_path"] == "/resolved/deep-link"

    network = client.get(f"/api/v1/results/{result_id}/network-summary").json()
    assert network["collector_status"] == "completed"
    assert network["summary"]["pending"] == 1
    assert network["entries"][0]["url_path"] == "/api/chart"

    runtime = client.get(f"/api/v1/results/{result_id}/runtime-summary").json()
    assert runtime == {
        "collector_status": "completed",
        "counts": {"pageerror": 1},
        "count": 1,
        "entries": [{"level": "error", "kind": "pageerror", "text": "safe failure"}],
    }

    visual = client.get(f"/api/v1/results/{result_id}/visual-evidence").json()
    assert visual["manifest"]["route"] == "/resolved/deep-link"

    readiness = client.get(f"/api/v1/results/{result_id}/readiness-summary").json()
    assert readiness["status"] == "passed"
    assert readiness["evidence_state"] == "captured_settled"
    assert readiness["manifest_schema"] == 2
    assert readiness["route"] == "/resolved/deep-link"


def test_missing_collectors_are_explicit_not_captured(client):
    run_id = create_run(client)
    ingest(client, run_id, [result_payload("passed")])
    result_id = client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0]["id"]

    assert client.get(f"/api/v1/results/{result_id}/network-summary").json()["collector_status"] == "not_captured"
    assert client.get(f"/api/v1/results/{result_id}/runtime-summary").json()["collector_status"] == "not_captured"
    readiness = client.get(f"/api/v1/results/{result_id}/readiness-summary").json()
    assert readiness["status"] == "not_captured"
    assert readiness["evidence_state"] == "not_applicable"


def test_manifest_v2_rejects_invalid_evidence_state(client, settings):
    run_id = create_run(client)
    path = Path(settings.artifacts_dir) / "runs" / run_id / "case" / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "schemaVersion": 2,
        "evidenceState": "pretend_pass",
        "readiness": {"status": "passed"},
        "frames": [],
        "finalScreenshot": None,
        "contactSheet": None,
    }))
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("passed", artifacts=[{
            "type": "visual_manifest",
            "storage_key": str(path.relative_to(settings.artifacts_dir)),
        }])],
    )
    assert response.status_code == 400
    assert response.json()["title"] == "Invalid artifact"
