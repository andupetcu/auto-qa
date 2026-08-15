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
from mcp.server.transport_security import TransportSecuritySettings

logger = logging.getLogger(__name__)


class _McpPathMiddleware:
    def __init__(self, app):
        self._app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http" and scope.get("path") == "/mcp":
            scope = dict(scope, path="/mcp/")
        await self._app(scope, receive, send)


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
            # mounted at /mcp with the inner route at "/": a request to exactly /mcp
            # arrives with path "" and would 307 to /mcp/, which MCP clients don't
            # follow on POST — normalize instead of redirecting
            if scope.get("path", "") in ("", "/mcp"):
                scope = dict(scope, path="/")
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
    inner = _RawMCPServer(name="auto-qa", version="0.2")

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

    async def _patch(path: str, json_body: dict | None = None):
        async with _client() as client:
            resp = await client.patch(path, json=json_body or {})
            resp.raise_for_status()
            return resp.json()

    async def _put(path: str, json_body: dict | None = None):
        async with _client() as client:
            resp = await client.put(path, json=json_body or {})
            resp.raise_for_status()
            return resp.json()

    async def _delete(path: str):
        async with _client() as client:
            resp = await client.delete(path)
            resp.raise_for_status()
            return resp.json()

    handlers: dict = {}

    @inner.tool()
    async def capabilities() -> dict:
        return await _get("/api/v1/capabilities")

    handlers["capabilities"] = capabilities

    @inner.tool()
    async def list_routes(project: str | None = None) -> dict:
        data = await _get("/api/v1/routes", {"project": project})
        return {"routes": data}

    handlers["list_routes"] = list_routes

    @inner.tool()
    async def run_suite(
        routes: list[str],
        project: str | None = None,
        roles: list[str] | None = None,
        browsers: list[str] | None = None,
        viewports: list[str] | None = None,
        base_url: str | None = None,
        app_version: str | None = None,
    ) -> dict:
        body = {"routes": routes}
        if project is not None:
            body["project"] = project
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
    async def get_run_results(
        run_id: str,
        status: str | None = None,
        role: str | None = None,
        route: str | None = None,
        browser: str | None = None,
        flaky: bool | None = None,
        limit: int | None = None,
    ) -> dict:
        """Return bounded case-level results for a run with optional filters."""
        data = await _get(
            f"/api/v1/runs/{run_id}/results",
            {
                "status": status,
                "role": role,
                "route": route,
                "browser": browser,
                "flaky": flaky,
                "limit": limit,
            },
        )
        return {"run_id": run_id, "count": len(data), "results": data}

    handlers["get_run_results"] = get_run_results

    @inner.tool()
    async def cancel_run(run_id: str) -> dict:
        """Cancel a queued or running run and terminate its worker tree."""
        return await _post(f"/api/v1/runs/{run_id}/cancel")

    handlers["cancel_run"] = cancel_run

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
    async def get_visual_evidence(result_id: str) -> dict:
        """Return the bounded visual timeline, manifest, warnings, and signed images."""
        return await _get(f"/api/v1/results/{result_id}/visual-evidence")

    handlers["get_visual_evidence"] = get_visual_evidence

    @inner.tool()
    async def rerun(
        run_id: str,
        scope: str = "failed",
        result_id: str | None = None,
        base_url: str | None = None,
        app_version: str | None = None,
    ) -> dict:
        """Rerun failed/affected/full scope or one exact route-backed result."""
        body: dict = {"scope": scope}
        if result_id is not None:
            body["result_id"] = result_id
        if base_url is not None:
            body["base_url"] = base_url
        if app_version is not None:
            body["app_version"] = app_version
        return await _post(f"/api/v1/runs/{run_id}/rerun", body)

    handlers["rerun"] = rerun

    @inner.tool()
    async def create_project(
        name: str,
        base_url: str,
        roles: list[dict] | None = None,
        selectors: dict | None = None,
        role_matrix: dict | None = None,
        routes: list[str] | None = None,
    ) -> dict:
        body: dict = {"name": name, "base_url_default": base_url}
        if roles is not None:
            body["roles"] = roles
        if selectors is not None:
            body["selectors"] = selectors
        if role_matrix is not None:
            body["role_matrix"] = role_matrix
        if routes is not None:
            body["routes"] = routes
        return await _post("/api/v1/projects", body)

    handlers["create_project"] = create_project

    @inner.tool()
    async def update_project(
        name: str,
        base_url: str | None = None,
        roles: list[dict] | None = None,
        selectors: dict | None = None,
        role_matrix: dict | None = None,
        routes: list[str] | None = None,
    ) -> dict:
        body: dict = {}
        if base_url is not None:
            body["base_url_default"] = base_url
        if roles is not None:
            body["roles"] = roles
        if selectors is not None:
            body["selectors"] = selectors
        if role_matrix is not None:
            body["role_matrix"] = role_matrix
        if routes is not None:
            body["routes"] = routes
        return await _patch(f"/api/v1/projects/{name}", body)

    handlers["update_project"] = update_project

    @inner.tool()
    async def list_projects() -> dict:
        data = await _get("/api/v1/projects")
        return {"projects": data}

    handlers["list_projects"] = list_projects

    @inner.tool()
    async def list_schedules() -> dict:
        """List durable project schedules."""
        data = await _get("/api/v1/schedules")
        return {"schedules": data}

    handlers["list_schedules"] = list_schedules

    @inner.tool()
    async def get_schedule(project: str) -> dict:
        """Get the schedule associated with one project."""
        return await _get(f"/api/v1/schedules/{project}")

    handlers["get_schedule"] = get_schedule

    @inner.tool()
    async def create_schedule(project: str, cron: str, enabled: bool = True) -> dict:
        """Create or replace a project's UTC schedule."""
        return await _put(
            f"/api/v1/schedules/{project}",
            {"cron": cron, "enabled": enabled},
        )

    handlers["create_schedule"] = create_schedule

    @inner.tool()
    async def update_schedule(
        project: str,
        cron: str | None = None,
        enabled: bool | None = None,
    ) -> dict:
        """Update cron and/or enabled state for a project schedule."""
        body: dict = {}
        if cron is not None:
            body["cron"] = cron
        if enabled is not None:
            body["enabled"] = enabled
        return await _patch(f"/api/v1/schedules/{project}", body)

    handlers["update_schedule"] = update_schedule

    @inner.tool()
    async def delete_schedule(project: str) -> dict:
        """Delete a project's schedule while preserving the project."""
        return await _delete(f"/api/v1/schedules/{project}")

    handlers["delete_schedule"] = delete_schedule

    @inner.tool()
    async def pause_schedule(project: str) -> dict:
        """Pause a project schedule without deleting its cron expression."""
        return await _post(f"/api/v1/schedules/{project}/pause")

    handlers["pause_schedule"] = pause_schedule

    @inner.tool()
    async def resume_schedule(project: str) -> dict:
        """Resume a paused project schedule."""
        return await _post(f"/api/v1/schedules/{project}/resume")

    handlers["resume_schedule"] = resume_schedule

    @inner.tool()
    async def run_schedule_now(project: str) -> dict:
        """Fire a schedule immediately while enforcing overlap policy."""
        return await _post(f"/api/v1/schedules/{project}/run")

    handlers["run_schedule_now"] = run_schedule_now

    @inner.tool()
    async def get_schedule_history(project: str, limit: int | None = None) -> dict:
        """Return bounded schedule-triggered run history for one project."""
        data = await _get(
            f"/api/v1/schedules/{project}/history", {"limit": limit}
        )
        return {"project": project, "count": len(data), "runs": data}

    handlers["get_schedule_history"] = get_schedule_history

    return QAMCPServer(inner, handlers)


def mount_mcp(app, settings) -> None:
    """Best-effort mount of the MCP streamable HTTP app at /mcp. Never raises."""
    try:
        mcp = build_mcp(app, settings)
        # inner path "/" so the endpoint is exactly /mcp (default would give /mcp/mcp)
        sub = mcp.streamable_http_app(
            streamable_http_path="/",
            transport_security=TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=settings.mcp_allowed_host_list,
            ),
        )
        app.mount("/mcp", BearerAuthASGI(sub, settings.api_token))
        # the outer router 307s "/mcp" -> "/mcp/" before the mount is entered; MCP
        # clients don't follow POST redirects, so normalize the path ahead of routing
        app.add_middleware(_McpPathMiddleware)
        # FastAPI does not run mounted sub-app lifespans; the app's own lifespan
        # (app/main.py) starts this session manager so /mcp works over real HTTP
        app.state.mcp_session_manager = mcp.session_manager
    except Exception:
        logger.exception("MCP mount failed; continuing without /mcp")
