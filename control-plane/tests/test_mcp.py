import pytest
from fastapi.testclient import TestClient

EXPECTED_TOOLS = {
    "capabilities", "list_routes", "run_suite", "get_run_status",
    "get_failure_bundles", "get_console_logs", "get_har", "get_artifacts", "rerun",
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
    # context manager runs the lifespan, starting the MCP session manager as uvicorn would
    with TestClient(app) as c:
        # unauthenticated → 401 before the MCP app ever sees the request
        assert c.post("/mcp", json={}).status_code == 401
        assert c.post("/mcp", json={}, headers={"Authorization": "Bearer wrong"}).status_code == 401
        # with the token the request reaches the MCP app; it must answer at exactly /mcp
        # (no /mcp/mcp double path, no 500 from an unstarted session manager)
        r = c.post("/mcp", json={}, headers={"Authorization": "Bearer testtoken"})
        assert r.status_code not in (401, 404, 307, 500)


async def test_get_failure_bundles_empty_run(mcp):
    out = await mcp.call_tool("run_suite", {"routes": ["ALL"]})
    payload = out[1] if isinstance(out, tuple) else out
    bundles = await mcp.call_tool("get_failure_bundles", {"run_id": payload["run_id"]})
    bundles_payload = bundles[1] if isinstance(bundles, tuple) else bundles
    assert bundles_payload["bundles"] == []
