from conftest import create_run, finalize, ingest, result_payload, sig_input


def _seed(client):
    rid = create_run(client)
    same = sig_input(error="TypeError: cannot read <n>", route="/campaigns/reports", role="user")
    ingest(client, rid, [
        result_payload("failed", route="/campaigns/reports", role="user",
                       duration_ms=900, signature_input=same),
        result_payload("failed", route="/campaigns/reports", role="user",
                       duration_ms=2000, signature_input=same, browser="chromium",
                       viewport="390x844"),
        result_payload("failed", route="/", role="anon", duration_ms=100,
                       signature_input=sig_input(error="Gate missing", route="/", role="anon")),
        result_payload("failed", route="/campaigns/campaign-library", role="user", flaky=True,
                       reruns_attempted=3, reruns_failed=1,
                       signature_input=sig_input(error="flaky thing",
                                                 route="/campaigns/campaign-library")),
        result_payload("passed", route="/", role="user"),
    ])
    finalize(client, rid)
    return rid


def test_clusters_by_signature_and_excludes_flaky(client):
    rid = _seed(client)
    bundles = client.get(f"/api/v1/runs/{rid}/bundles").json()
    assert len(bundles) == 2
    by_occ = sorted(bundles, key=lambda b: -b["occurrences"])
    assert by_occ[0]["occurrences"] == 2
    assert by_occ[1]["occurrences"] == 1
    texts = str(bundles)
    assert "flaky thing" not in texts


def test_bundle_shape(client):
    rid = _seed(client)
    b = sorted(client.get(f"/api/v1/runs/{rid}/bundles").json(),
               key=lambda x: -x["occurrences"])[0]
    assert b["bundle_id"].startswith("fb_")
    assert b["cluster_id"].startswith("cl_")
    assert b["run_id"] == rid
    assert b["severity"] in ("low", "medium", "high")
    assert {"route": "/campaigns/reports", "role": "user"} in b["affected"]
    assert b["test"]["name"]
    assert b["test"]["file"]
    assert b["app"] == {"project": "fai", "base_url": "https://app.example.test",
                        "version": None}
    # exemplar = first by severity then duration: the 900ms one
    assert b["test"]["duration_ms"] == 900
    assert "artifact_expiry" in b


def test_failed_suite_test_with_null_route_clusters_cleanly(client):
    # non-matrix suite specs have route_path=None; finalize must still cluster them
    rid = create_run(client)
    ingest(client, rid, [
        result_payload("failed", route=None, role="user",
                       test_name="reports deeplink renders for seeded campaign",
                       signature_input={"normalized_error": "Timed out",
                                        "top_stack_frame": "", "route": "", "role": "user"}),
    ])
    finalize(client, rid)
    run = client.get(f"/api/v1/runs/{rid}").json()
    assert run["totals"]["failed"] == 1
    bundles = client.get(f"/api/v1/runs/{rid}/bundles").json()
    assert len(bundles) == 1


def test_severity_min_filter(client):
    rid = create_run(client)
    ingest(client, rid, [
        result_payload("failed", route="/", signature_input=sig_input(error="a 500"),
                       network_summary=[{"method": "GET", "url_path": "/api/x",
                                         "status": 500, "timing_ms": 50,
                                         "resp_snippet": ""}]),
        result_payload("failed", route="/campaigns/reports",
                       signature_input=sig_input(error="warn only",
                                                 route="/campaigns/reports"),
                       console_summary=[{"level": "warning", "text": "deprecated",
                                         "source": None, "raw_source": None, "count": 1}]),
    ])
    finalize(client, rid)
    all_b = client.get(f"/api/v1/runs/{rid}/bundles").json()
    high_b = client.get(f"/api/v1/runs/{rid}/bundles", params={"severity_min": "high"}).json()
    assert len(all_b) == 2
    assert len(high_b) == 1
    assert high_b[0]["severity"] == "high"
