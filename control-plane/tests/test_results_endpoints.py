from pathlib import Path

from conftest import create_run, finalize, ingest, result_payload, sig_input

CONSOLE = [
    {"level": "error", "kind": "pageerror", "text": "TypeError: boom",
     "source": "src/components/X.tsx:64:18", "raw_source": "bundle/index.js:1:88214",
     "count": 3},
    {"level": "warning", "kind": "console", "text": "deprecated API",
     "source": None, "raw_source": None, "count": 1},
]
NETWORK = [
    {"method": "GET", "url_path": "/api/v2/campaigns/1/budget", "status": 500,
     "timing_ms": 240, "resp_snippet": '{"error":"x"}'},
    {"method": "POST", "url_path": "/api/v2/events", "status": 400,
     "timing_ms": 90, "resp_snippet": ""},
]


def _seed(client, with_har_artifact=False):
    rid = create_run(client)
    artifacts = []
    if with_har_artifact:
        storage_key = f"runs/{rid}/t1/network.har"
        path = Path(client.app.state.settings.artifacts_dir) / storage_key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"log":{"entries":[]}}')
        artifacts = [{"type": "har", "storage_key": storage_key,
                      "bytes": path.stat().st_size}]
    ingest(client, rid, [result_payload(
        "failed", signature_input=sig_input(),
        console_summary=CONSOLE, network_summary=NETWORK, artifacts=artifacts)])
    finalize(client, rid)
    return client.get(f"/api/v1/runs/{rid}/results").json()[0]["id"]


def test_console_default_errors_only(client):
    res_id = _seed(client)
    rows = client.get(f"/api/v1/results/{res_id}/console").json()
    assert len(rows) == 1
    assert rows[0]["level"] == "error"
    assert rows[0]["count"] == 3


def test_console_level_all(client):
    res_id = _seed(client)
    rows = client.get(f"/api/v1/results/{res_id}/console",
                      params={"level": "all"}).json()
    assert len(rows) == 2


def test_har_failures_only_returns_rows(client):
    res_id = _seed(client)
    rows = client.get(f"/api/v1/results/{res_id}/har").json()
    assert [r["status"] for r in rows] == [500, 400]


def test_har_full_returns_signed_url(client):
    res_id = _seed(client, with_har_artifact=True)
    r = client.get(f"/api/v1/results/{res_id}/har",
                   params={"failures_only": "false"}).json()
    assert r["type"] == "har"
    assert "sig=" in r["url"]
