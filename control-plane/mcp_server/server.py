"""MCP server exposing the v0.1 tool subset over the in-process REST API.

Each tool makes exactly one in-process HTTP call to the FastAPI app via
httpx.ASGITransport (no network hop). build_mcp() returns a thin adapter around
the real mcp.server.mcpserver.MCPServer: list_tools()/streamable_http_app()
delegate straight through (so a real MCP client / streamable HTTP mount behaves
normally), while call_tool() bypasses the SDK's CallToolResult wrapping and
returns the tool handler's dict directly, since that's the shape our own tests
and Hermes-side callers expect.
"""
import hmac
import json
import logging

import httpx
from mcp.server.mcpserver import MCPServer as _RawMCPServer

logger = logging.getLogger(__name__)


class BearerAuthASGI:
    """Requires `Authorization: Bearer <token>` before dispatching to the inner app.

    The system has a single static token (doc 00 auth model), so gating the /mcp
    mount with it makes the MCP layer exactly as privileged as its caller — the
    internal ASGI client's embedded token grants nothing the caller hasn't proven.
    """

    def __init__(self, inner, token: str):
        self._inner = inner
        self._token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers") or [])
            auth = (headers.get(b"authorization") or b"").decode()
            expected = f"Bearer {self._token}"
            if not hmac.compare_digest(auth, expected):
                body = json.dumps({"title": "Unauthorized", "status": 401,
                                   "detail": "missing or invalid bearer token"}).encode()
                await send({"type": "http.response.start", "status": 401,
                            "headers": [(b"content-type", b"application/problem+json")]})
                await send({"type": "http.response.body", "body": body})
                return
        await self._inner(scope, receive, send)


class QAMCPServer:
    def __init__(self, inner: _RawMCPServer, handlers: dict):
        self._inner = inner
        self._handlers = handlers

    async def list_tools(self):
        return await self._inner.list_tools()

    async def call_tool(self, name: str, arguments: dict | None = None):
        arguments = arguments or {}
        handler = self._handlers[name]
        return await handler(**arguments)

    def streamable_http_app(self, **kwargs):
        return self._inner.streamable_http_app(**kwargs)

    @property
    def session_manager(self):
        return self._inner.session_manager


def build_mcp(app, settings) -> QAMCPServer:
    inner = _RawMCPServer(name="footprints-qa", version="0.1")

    def _client() -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://qa",
            headers={"Authorization": f"Bearer {settings.api_token}"},
        )

    async def _get(path: str, params: dict | None = None):
        params = {k: v for k, v in (params or {}).items() if v is not None}
        async with _client() as client:
            resp = await client.get(path, params=params)
            resp.raise_for_status()
            return resp.json()

    async def _post(path: str, json_body: dict | None = None):
        async with _client() as client:
            resp = await client.post(path, json=json_body or {})
            resp.raise_for_status()
            return resp.json()

    handlers: dict = {}

    @inner.tool()
    async def capabilities() -> dict:
        return await _get("/api/v1/capabilities")

    handlers["capabilities"] = capabilities

    @inner.tool()
    async def list_routes() -> dict:
        data = await _get("/api/v1/routes")
        return {"routes": data}

    handlers["list_routes"] = list_routes

    @inner.tool()
    async def run_suite(
        routes: list[str],
        roles: list[str] | None = None,
        browsers: list[str] | None = None,
        viewports: list[str] | None = None,
        base_url: str | None = None,
        app_version: str | None = None,
    ) -> dict:
        body = {"routes": routes}
        if roles is not None:
            body["roles"] = roles
        if browsers is not None:
            body["browsers"] = browsers
        if viewports is not None:
            body["viewports"] = viewports
        if base_url is not None:
            body["base_url"] = base_url
        if app_version is not None:
            body["app_version"] = app_version
        return await _post("/api/v1/runs", body)

    handlers["run_suite"] = run_suite

    @inner.tool()
    async def get_run_status(run_id: str) -> dict:
        return await _get(f"/api/v1/runs/{run_id}")

    handlers["get_run_status"] = get_run_status

    @inner.tool()
    async def get_failure_bundles(
        run_id: str,
        severity_min: str | None = None,
        include_flaky: bool | None = None,
    ) -> dict:
        data = await _get(
            f"/api/v1/runs/{run_id}/bundles",
            {"severity_min": severity_min, "include_flaky": include_flaky},
        )
        return {"bundles": data}

    handlers["get_failure_bundles"] = get_failure_bundles

    @inner.tool()
    async def get_console_logs(
        result_id: str, level: str | None = None, limit: int | None = None
    ) -> dict:
        data = await _get(
            f"/api/v1/results/{result_id}/console", {"level": level, "limit": limit}
        )
        return {"console": data}

    handlers["get_console_logs"] = get_console_logs

    @inner.tool()
    async def get_har(
        result_id: str,
        failures_only: bool | None = None,
        body_bytes: int | None = None,
    ) -> dict:
        data = await _get(
            f"/api/v1/results/{result_id}/har",
            {"failures_only": failures_only, "body_bytes": body_bytes},
        )
        if isinstance(data, list):
            return {"network": data}
        return data

    handlers["get_har"] = get_har

    @inner.tool()
    async def get_artifacts(result_id: str, types: str | None = None) -> dict:
        data = await _get(f"/api/v1/results/{result_id}/artifacts", {"types": types})
        return {"artifacts": data}

    handlers["get_artifacts"] = get_artifacts

    @inner.tool()
    async def rerun(
        run_id: str,
        scope: str,
        base_url: str | None = None,
        app_version: str | None = None,
    ) -> dict:
        body = {"scope": scope}
        if base_url is not None:
            body["base_url"] = base_url
        if app_version is not None:
            body["app_version"] = app_version
        return await _post(f"/api/v1/runs/{run_id}/rerun", body)

    handlers["rerun"] = rerun

    return QAMCPServer(inner, handlers)


def mount_mcp(app, settings) -> None:
    """Best-effort mount of the MCP streamable HTTP app at /mcp. Never raises."""
    try:
        mcp = build_mcp(app, settings)
        # inner path "/" so the endpoint is exactly /mcp (default would give /mcp/mcp)
        sub = mcp.streamable_http_app(streamable_http_path="/")
        app.mount("/mcp", BearerAuthASGI(sub, settings.api_token))
        # FastAPI does not run mounted sub-app lifespans; the app's own lifespan
        # (app/main.py) starts this session manager so /mcp works over real HTTP
        app.state.mcp_session_manager = mcp.session_manager
    except Exception:
        logger.exception("MCP mount failed; continuing without /mcp")
