"""FastAPI app factory."""
import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import HTMLResponse, Response


class _SPAStaticFiles(StaticFiles):
    """Serve the built SPA. Two local-only conveniences:
    - fall back to index.html for client-side routes so deep links/refreshes don't 404;
    - inject the API token into index.html so the same-origin UI auto-connects with no
      login (the control plane binds to 127.0.0.1, so the token never leaves the host).
    """

    def __init__(self, *args, api_token: str = "", **kwargs):
        super().__init__(*args, **kwargs)
        self._api_token = api_token

    async def get_response(self, path: str, scope) -> Response:
        # real asset files (assets/*.js, *.css, *.map, favicon…) serve verbatim;
        # everything else — the root and all client-side routes — gets the injected index
        candidate = Path(self.directory) / path
        if path not in ("", ".", "index.html") and candidate.is_file():
            return await super().get_response(path, scope)
        return self._inject_index()

    def _inject_index(self) -> HTMLResponse:
        html = (Path(self.directory) / "index.html").read_text()
        tag = f"<script>window.__QA_TOKEN__={self._api_token!r};</script>"
        html = html.replace("</head>", f"{tag}</head>", 1)
        return HTMLResponse(html)

_SCHEDULER_INTERVAL_SECONDS = 30
_REPO_ROOT = Path(__file__).resolve().parents[2]


async def _scheduler_tick(app: FastAPI, now: datetime | None = None) -> None:
    """One scheduler pass: trigger a run for every project whose cron is due, then
    advance its last_scheduled_at so the same boundary can't fire twice. `now` is
    injectable for tests."""
    from app.api.runs import create_run_row
    from app.db import Project
    from app.services.scheduler import projects_due

    settings = app.state.settings
    if now is None:
        now = datetime.now(timezone.utc)
    with app.state.SessionLocal() as session:
        projects = session.query(Project).all()
        for project in projects_due(projects, now):
            try:
                create_run_row(
                    session,
                    settings,
                    project,
                    routes=["ALL"],
                    roles=[r["name"] for r in (project.roles or [])],
                    trigger="schedule",
                )
            except Exception:
                logger.exception(
                    "scheduler: failed to trigger run for project_id=%s", project.id
                )
            project.last_scheduled_at = now
        session.commit()


async def _scheduler_loop(app: FastAPI) -> None:
    """Best-effort loop: never lets a bad tick (or a bad project) kill the app."""
    while True:
        try:
            await asyncio.sleep(_SCHEDULER_INTERVAL_SECONDS)
            await _scheduler_tick(app)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("scheduler loop iteration failed")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    scheduler_task = None
    if getattr(app.state.settings, "scheduler_enabled", False):
        scheduler_task = asyncio.create_task(_scheduler_loop(app))

    try:
        # FastAPI never runs mounted sub-app lifespans; the MCP streamable-HTTP
        # session manager (set by mount_mcp) must be started here or /mcp 500s on
        # every request
        sm = getattr(app.state, "mcp_session_manager", None)
        if sm is None:
            yield
        else:
            async with sm.run():
                yield
    finally:
        if scheduler_task is not None:
            scheduler_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await scheduler_task

from app.api import artifacts, capabilities, internal, projects as projects_api, results
from app.api import matrix as matrix_api
from app.api import routes as routes_api
from app.api import runs
from app.db import Base, make_engine_and_sessionmaker
from app.problems import register_problem_handlers
from app.services.discovery import ensure_default_project, seed_config_routes
from app.settings import Settings

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, webhook_transport=None) -> FastAPI:
    if settings is None:
        settings = Settings()

    app = FastAPI(title="Auto QA Control Plane", version="0.1", lifespan=_lifespan)

    engine, session_local = make_engine_and_sessionmaker(settings.database_url)
    Base.metadata.create_all(bind=engine)

    app.state.settings = settings
    app.state.engine = engine
    app.state.SessionLocal = session_local
    app.state.webhook_transport = webhook_transport
    app.state.event_sequences = {}

    with session_local() as session:
        default_project = ensure_default_project(session, settings)
        seed_config_routes(session, settings, default_project)

    register_problem_handlers(app)

    app.include_router(capabilities.router, prefix="/api/v1")
    app.include_router(projects_api.router, prefix="/api/v1")
    app.include_router(routes_api.router, prefix="/api/v1")
    app.include_router(matrix_api.router, prefix="/api/v1")
    app.include_router(runs.router, prefix="/api/v1")
    app.include_router(results.router, prefix="/api/v1")
    app.include_router(internal.router, prefix="/api/v1/internal")
    app.include_router(artifacts.router)  # unauthenticated, signed URLs only

    try:
        from mcp_server.server import mount_mcp

        mount_mcp(app, settings)
    except Exception:
        logger.exception("failed to mount MCP server (non-fatal)")

    web_ui_dist = _REPO_ROOT / "web-ui" / "dist"
    if web_ui_dist.is_dir():
        try:
            app.mount(
                "/ui",
                _SPAStaticFiles(directory=str(web_ui_dist), html=True,
                                api_token=settings.api_token),
                name="ui",
            )
        except Exception:
            logger.exception("failed to mount /ui static files (non-fatal)")

    return app
