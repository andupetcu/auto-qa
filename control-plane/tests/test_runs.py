"""Run creation, result rerun and idempotency API contracts."""

import json

from conftest import create_run, finalize, ingest, result_payload, sig_input


def test_create_run_returns_202_queued(client):
    r = client.post("/api/v1/runs", json={"routes": ["ALL"], "roles": ["user", "anon"]})
    assert r.status_code == 202
    body = r.json()
    assert body["run_id"].startswith("run_")
    assert body["status"] == "queued"


def test_run_defaults_and_overrides(client):
    rid = create_run(client)
    run = client.get(f"/api/v1/runs/{rid}").json()
    assert run["base_url"] == "https://app.example.test"
    assert run["app_version"] is None
    assert run["trigger"] == "manual"
    assert run["requested_routes"] == ["ALL"]

    rid2 = create_run(client, base_url="https://other.example.test", app_version="v42")
    run2 = client.get(f"/api/v1/runs/{rid2}").json()
    assert run2["base_url"] == "https://other.example.test"
    assert run2["app_version"] == "v42"


def test_idempotency_key_replay_returns_same_run(client):
    h = {"Idempotency-Key": "abc123"}
    r1 = client.post("/api/v1/runs", json={"routes": ["ALL"]}, headers=h)
    r2 = client.post("/api/v1/runs", json={"routes": ["ALL"]}, headers=h)
    assert r1.json()["run_id"] == r2.json()["run_id"]


def test_unknown_route_is_problem_json(client):
    r = client.post("/api/v1/runs", json={"routes": ["/does-not-exist"]})
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/problem+json")
    assert "/does-not-exist" in r.json()["detail"]


def test_list_runs(client):
    create_run(client)
    r = client.get("/api/v1/runs")
    assert r.status_code == 200
    assert len(r.json()) >= 1


def test_get_missing_run_404_problem(client):
    r = client.get("/api/v1/runs/run_00000000000000000000000000")
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")


def _run_with_one_failure(client):
    rid = create_run(client, routes=["/", "/campaigns/reports"])
    ingest(client, rid, [
        result_payload("passed", route="/", role="user"),
        result_payload("failed", route="/campaigns/reports", role="user",
                       signature_input=sig_input(route="/campaigns/reports")),
    ])
    finalize(client, rid)
    return rid


def test_rerun_failed_scope(client):
    rid = _run_with_one_failure(client)
    r = client.post(f"/api/v1/runs/{rid}/rerun", json={"scope": "failed"})
    assert r.status_code == 202
    new_id = r.json()["run_id"]
    assert new_id != rid
    new_run = client.get(f"/api/v1/runs/{new_id}").json()
    assert new_run["parent_run_id"] == rid
    assert new_run["requested_routes"] == ["/campaigns/reports"]


def test_rerun_failed_scope_ignores_null_route_suite_failures(client):
    rid = create_run(client, routes=["/", "/campaigns/reports"])
    ingest(client, rid, [
        result_payload("failed", route="/campaigns/reports", role="user",
                       signature_input=sig_input(route="/campaigns/reports")),
        result_payload("failed", route=None, role="user",
                       test_name="reports deeplink renders",
                       signature_input={"normalized_error": "x", "top_stack_frame": "",
                                        "route": "", "role": "user"}),
    ])
    finalize(client, rid)
    r = client.post(f"/api/v1/runs/{rid}/rerun", json={"scope": "failed"})
    assert r.status_code == 202
    new_run = client.get(f"/api/v1/runs/{r.json()['run_id']}").json()
    assert new_run["requested_routes"] == ["/campaigns/reports"]


def test_rerun_failed_scope_with_only_suite_failures_is_400(client):
    rid = create_run(client, routes=["/"])
    ingest(client, rid, [
        result_payload("failed", route=None, role="user",
                       test_name="reports deeplink renders",
                       signature_input={"normalized_error": "x", "top_stack_frame": "",
                                        "route": "", "role": "user"}),
    ])
    finalize(client, rid)
    r = client.post(f"/api/v1/runs/{rid}/rerun", json={"scope": "failed"})
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/problem+json")


def test_run_creation_rejects_multi_browser_or_viewport_matrix(client):
    response = client.post(
        "/api/v1/runs",
        json={
            "project": "fai",
            "routes": ["/"],
            "browsers": ["chromium", "firefox"],
            "viewports": ["1440x900"],
        },
    )
    assert response.status_code == 422

    response = client.post(
        "/api/v1/runs",
        json={
            "project": "fai",
            "routes": ["/"],
            "browsers": ["chromium"],
            "viewports": ["1440x900", "390x844"],
        },
    )
    assert response.status_code == 422


def test_run_creation_rejects_role_not_configured_for_project(client):
    updated = client.patch(
        "/api/v1/projects/fai",
        json={"roles": [{"name": "anon"}]},
    )
    assert updated.status_code == 200

    response = client.post(
        "/api/v1/runs",
        json={
            "project": "fai",
            "routes": ["/"],
            "roles": ["user", "anon"],
            "browsers": ["chromium"],
            "viewports": ["1440x900"],
        },
    )

    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["title"] == "Unknown role"


def test_rerun_single_result_preserves_case_matrix(client, app, settings):
    run_id = create_run(
        client,
        routes=["/campaigns/reports"],
        roles=["user", "anon"],
        browsers=["firefox"],
        viewports=["390x844"],
    )
    ingest(
        client,
        run_id,
        [
            result_payload(
                "failed",
                route="/campaigns/reports",
                role="anon",
                browser="firefox",
                viewport="390x844",
                signature_input=sig_input(
                    route="/campaigns/reports", role="anon"
                ),
            )
        ],
    )
    finalize(client, run_id)
    result_id = client.get(f"/api/v1/runs/{run_id}/results").json()[0]["id"]

    response = client.post(
        f"/api/v1/runs/{run_id}/rerun",
        json={"scope": "result", "result_id": result_id},
    )

    assert response.status_code == 202, response.text
    retry = client.get(f"/api/v1/runs/{response.json()['run_id']}").json()
    assert retry["parent_run_id"] == run_id
    assert retry["requested_routes"] == ["/campaigns/reports"]
    assert retry["requested_roles"] == ["anon"]
    assert retry["browsers"] == ["firefox"]
    assert retry["viewports"] == ["390x844"]

    from app.db import Project, TestRun
    from app.services.runner import build_spawn_env

    with app.state.SessionLocal() as session:
        retry_row = session.get(TestRun, retry["id"])
        project = session.get(Project, retry_row.project_id)
        env = build_spawn_env(retry_row, project, settings)
    assert json.loads(env["QA_RUN_BROWSERS"]) == ["firefox"]
    assert json.loads(env["QA_RUN_VIEWPORTS"]) == ["390x844"]


def test_rerun_full_scope_with_base_url_override(client):
    rid = _run_with_one_failure(client)
    r = client.post(f"/api/v1/runs/{rid}/rerun",
                    json={"scope": "full", "base_url": "https://staging.example.test"})
    new_run = client.get(f"/api/v1/runs/{r.json()['run_id']}").json()
    assert new_run["requested_routes"] == ["/", "/campaigns/reports"]
    assert new_run["base_url"] == "https://staging.example.test"
