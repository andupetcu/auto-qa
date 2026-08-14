"""FastAPI app factory."""
import logging

from fastapi import FastAPI

from app.api import artifacts, capabilities, internal, results, routes as routes_api, runs
from app.db import Base, make_engine_and_sessionmaker
from app.problems import register_problem_handlers
from app.services.discovery import seed_config_routes
from app.settings import Settings

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None, webhook_transport=None) -> FastAPI:
    if settings is None:
        settings = Settings()

    app = FastAPI(title="Footprints QA Control Plane", version="0.1")

    engine, session_local = make_engine_and_sessionmaker(settings.database_url)
    Base.metadata.create_all(bind=engine)

    app.state.settings = settings
    app.state.engine = engine
    app.state.SessionLocal = session_local
    app.state.webhook_transport = webhook_transport
    app.state.event_sequences = {}

    with session_local() as session:
        seed_config_routes(session, settings)

    register_problem_handlers(app)

    app.include_router(capabilities.router, prefix="/api/v1")
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
