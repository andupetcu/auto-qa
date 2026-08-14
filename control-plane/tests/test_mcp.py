"""Public MCP contract tests for deterministic Auto QA operator tools."""

import pytest
from fastapi.testclient import TestClient

from conftest import create_run, ingest, result_payload

EXPECTED_TOOLS = {
    "capabilities", "list_routes", "run_suite", "get_run_status", "get_run_results",
    "cancel_run",
    "get_failure_bundles", "get_console_logs", "get_har", "get_artifacts", "rerun",
    "list_projects", "create_project", "update_project",
    "list_schedules", "get_schedule", "create_schedule", "update_schedule",
    "pause_schedule", "resume_schedule", "run_schedule_now", "get_schedule_history",
}


@pytest.fixture()
def mcp(app, settings):
    from mcp_server.server import build_mcp

    return build_mcp(app, settings)


async def test_exposes_v01_tool_subset(mcp):
    tools = await mcp.list_tools()
    assert {t.name for t in tools} == EXPECTED_TOOLS


async def test_run_suite_and_status_roundtrip(mcp):
    out = await mcp.call_tool("run_suite", {"routes": ["ALL"], "roles": ["user"]})
    payload = out[1] if isinstance(out, tuple) else out
    run_id = payload["run_id"]
    assert run_id.startswith("run_")
    status = await mcp.call_tool("get_run_status", {"run_id": run_id})
    status_payload = status[1] if isinstance(status, tuple) else status
    assert status_payload["status"] == "queued"


def test_mcp_http_mount_requires_bearer_token(app):
    # context manager runs the lifespan, starting the MCP session manager as uvicorn would;
    # redirects off because real MCP clients do not follow a 307 on POST /mcp
    with TestClient(app, follow_redirects=False) as c:
        # unauthenticated → 401 before the MCP app ever sees the request
        assert c.post("/mcp", json={}).status_code == 401
        assert c.post("/mcp", json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401
        # with the token the request reaches the MCP app; it must answer at exactly /mcp
        # (no /mcp/mcp double path, no 500 from an unstarted session manager)
        r = c.post("/mcp", json={}, headers={"Authorization": "Bearer testtoken"})
        assert r.status_code not in (401, 404, 307, 500)


async def test_create_project_and_scoped_run_via_mcp(mcp):
    out = await mcp.call_tool("create_project", {
        "name": "mcpproj", "base_url": "https://mcp.example.test", "routes": ["/"],
    })
    created = out[1] if isinstance(out, tuple) else out
    assert created["name"] == "mcpproj"

    listed = await mcp.call_tool("list_projects", {})
    listed = listed[1] if isinstance(listed, tuple) else listed
    assert "mcpproj" in [p["name"] for p in listed["projects"]]

    run = await mcp.call_tool("run_suite", {"project": "mcpproj", "routes": ["ALL"]})
    run = run[1] if isinstance(run, tuple) else run
    status = await mcp.call_tool("get_run_status", {"run_id": run["run_id"]})
    status = status[1] if isinstance(status, tuple) else status
    assert status["project"] == "mcpproj"


async def test_update_project_via_mcp_remaps_base_url(mcp):
    await mcp.call_tool("create_project", {
        "name": "updproj", "base_url": "https://one.example.test", "routes": ["/"]})
    out = await mcp.call_tool("update_project",
                              {"name": "updproj", "base_url": "https://two.example.test"})
    updated = out[1] if isinstance(out, tuple) else out
    assert updated["base_url_default"] == "https://two.example.test"


async def test_get_run_results_filters_cases(mcp, client):
    run_id = create_run(client)
    ingest(
        client,
        run_id,
        [
            result_payload("passed", route="/", role="anon"),
            result_payload(
                "failed",
                route="/campaigns/reports",
                role="user",
                console_summary=[{"level": "error", "text": "boom"}],
            ),
        ],
    )

    out = await mcp.call_tool(
        "get_run_results",
        {"run_id": run_id, "status": "failed", "role": "user", "limit": 10},
    )
    payload = out[1] if isinstance(out, tuple) else out
    assert payload["run_id"] == run_id
    assert payload["count"] == 1
    assert payload["results"][0]["route_path"] == "/campaigns/reports"
    assert payload["results"][0]["console_summary"][0]["text"] == "boom"

    retry = await mcp.call_tool(
        "rerun",
        {
            "run_id": run_id,
            "scope": "result",
            "result_id": payload["results"][0]["id"],
        },
    )
    retry_payload = retry[1] if isinstance(retry, tuple) else retry
    retry_run = client.get(f"/api/v1/runs/{retry_payload['run_id']}").json()
    assert retry_run["requested_routes"] == ["/campaigns/reports"]
    assert retry_run["requested_roles"] == ["user"]


async def test_cancel_run_via_mcp(mcp, client):
    run_id = create_run(client)
    out = await mcp.call_tool("cancel_run", {"run_id": run_id})
    payload = out[1] if isinstance(out, tuple) else out
    assert payload == {"run_id": run_id, "status": "canceled"}
    assert client.get(f"/api/v1/runs/{run_id}").json()["status"] == "canceled"


async def test_schedule_lifecycle_via_mcp(mcp):
    created = await mcp.call_tool(
        "create_schedule",
        {"project": "fai", "cron": "*/15 * * * *", "enabled": True},
    )
    created_payload = created[1] if isinstance(created, tuple) else created
    assert created_payload["cron"] == "*/15 * * * *"

    listed = await mcp.call_tool("list_schedules")
    listed_payload = listed[1] if isinstance(listed, tuple) else listed
    assert listed_payload["schedules"][0]["project"] == "fai"

    updated = await mcp.call_tool(
        "update_schedule", {"project": "fai", "cron": "0 * * * *"}
    )
    updated_payload = updated[1] if isinstance(updated, tuple) else updated
    assert updated_payload["cron"] == "0 * * * *"

    paused = await mcp.call_tool("pause_schedule", {"project": "fai"})
    paused_payload = paused[1] if isinstance(paused, tuple) else paused
    assert paused_payload["enabled"] is False

    resumed = await mcp.call_tool("resume_schedule", {"project": "fai"})
    resumed_payload = resumed[1] if isinstance(resumed, tuple) else resumed
    assert resumed_payload["enabled"] is True

    fired = await mcp.call_tool("run_schedule_now", {"project": "fai"})
    fired_payload = fired[1] if isinstance(fired, tuple) else fired
    assert fired_payload["status"] == "queued"

    history = await mcp.call_tool(
        "get_schedule_history", {"project": "fai", "limit": 10}
    )
    history_payload = history[1] if isinstance(history, tuple) else history
    assert history_payload["runs"][0]["id"] == fired_payload["run_id"]


async def test_get_failure_bundles_empty_run(mcp):
    out = await mcp.call_tool("run_suite", {"routes": ["ALL"]})
    payload = out[1] if isinstance(out, tuple) else out
    bundles = await mcp.call_tool("get_failure_bundles", {"run_id": payload["run_id"]})
    bundles_payload = bundles[1] if isinstance(bundles, tuple) else bundles
    assert bundles_payload["bundles"] == []
