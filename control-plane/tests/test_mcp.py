import pytest

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


async def test_get_failure_bundles_empty_run(mcp):
    out = await mcp.call_tool("run_suite", {"routes": ["ALL"]})
    payload = out[1] if isinstance(out, tuple) else out
    bundles = await mcp.call_tool("get_failure_bundles", {"run_id": payload["run_id"]})
    bundles_payload = bundles[1] if isinstance(bundles, tuple) else bundles
    assert bundles_payload["bundles"] == []
