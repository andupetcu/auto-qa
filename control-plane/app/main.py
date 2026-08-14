"""FastAPI app factory."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # FastAPI never runs mounted sub-app lifespans; the MCP streamable-HTTP session
    # manager (set by mount_mcp) must be started here or /mcp 500s on every request
    sm = getattr(app.state, "mcp_session_manager", None)
    if sm is None:
        yield
    else:
        async with sm.run():
            yield

from app.api import artifacts, capabilities, internal, projects as projects_api, results
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

    app = FastAPI(title="Footprints QA Control Plane", version="0.1", lifespan=_lifespan)

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
    app.include_router(runs.router, prefix="/api/v1")
    app.include_router(results.router, prefix="/api/v1")
    app.include_router(internal.router, prefix="/api/v1/internal")
    app.include_router(artifacts.router)  # unauthenticated, signed URLs only

    try:
        from mcp_server.server import mount_mcp

        mount_mcp(app, settings)
    except Exception:
        logger.exception("failed to mount MCP server (non-fatal)")

    return app
