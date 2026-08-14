from conftest import create_run, finalize, ingest, result_payload, sig_input


def _bundle_severity(client, **result_kw):
    rid = create_run(client)
    ingest(client, rid, [result_payload("failed", signature_input=sig_input(), **result_kw)])
    finalize(client, rid)
    bundles = client.get(f"/api/v1/runs/{rid}/bundles").json()
    assert len(bundles) == 1
    return bundles[0]["severity"]


def test_network_5xx_is_high(client):
    sev = _bundle_severity(client, network_summary=[
        {"method": "GET", "url_path": "/api/v2/x", "status": 500,
         "timing_ms": 240, "resp_snippet": "boom"}])
    assert sev == "high"


def test_pageerror_is_high(client):
    sev = _bundle_severity(client, console_summary=[
        {"level": "error", "kind": "pageerror",
         "text": "TypeError: x is undefined", "source": None,
         "raw_source": "bundle/index.js:1:2", "count": 1}])
    assert sev == "high"


def test_assertion_with_shell_rendered_is_medium(client):
    sev = _bundle_severity(client, shell_rendered=True,
                           failed_action={"step": "expect(x).toBeVisible()",
                                          "error": "timed out", "actual": None})
    assert sev == "medium"


def test_warning_only_is_low(client):
    sev = _bundle_severity(client, console_summary=[
        {"level": "warning", "text": "deprecation", "source": None,
         "raw_source": None, "count": 4}])
    assert sev == "low"


def test_default_is_medium(client):
    assert _bundle_severity(client) == "medium"
