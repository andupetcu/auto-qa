"""SQLAlchemy models + per-app engine/sessionmaker factory."""
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    UniqueConstraint,
    create_engine,
)
from sqlalchemy.orm import DeclarativeBase, sessionmaker


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Route(Base):
    __tablename__ = "route"

    id = Column(String, primary_key=True)
    base_url = Column(String, nullable=False)
    path = Column(String, nullable=False)
    discovery_source = Column(String, nullable=False)
    first_seen = Column(DateTime, nullable=False, default=_utcnow)
    last_seen = Column(DateTime, nullable=False, default=_utcnow)

    __table_args__ = (UniqueConstraint("base_url", "path", name="uq_route_base_url_path"),)


class TestRun(Base):
    __tablename__ = "test_run"

    id = Column(String, primary_key=True)
    trigger = Column(String, nullable=False)
    base_url = Column(String, nullable=False)
    app_version = Column(String, nullable=True)
    requested_routes = Column(JSON, nullable=False, default=list)
    requested_roles = Column(JSON, nullable=False, default=list)
    browsers = Column(JSON, nullable=False, default=list)
    viewports = Column(JSON, nullable=False, default=list)
    capture_config = Column(JSON, nullable=False, default=dict)
    idempotency_key = Column(String, nullable=True, unique=True)
    parent_run_id = Column(String, nullable=True)
    started_at = Column(DateTime, nullable=True)
    ended_at = Column(DateTime, nullable=True)
    status = Column(String, nullable=False)
    totals = Column(JSON, nullable=True)
    detail = Column(String, nullable=True)


class TestResult(Base):
    __tablename__ = "test_result"

    id = Column(String, primary_key=True)
    run_id = Column(String, nullable=False)
    test_name = Column(String, nullable=False)
    test_file = Column(String, nullable=False)
    route_path = Column(String, nullable=False)
    role = Column(String, nullable=False)
    browser = Column(String, nullable=True)
    viewport = Column(String, nullable=True)
    status = Column(String, nullable=False)
    duration_ms = Column(Integer, nullable=True)
    flaky = Column(Boolean, nullable=False, default=False)
    reruns_attempted = Column(Integer, nullable=False, default=0)
    reruns_failed = Column(Integer, nullable=False, default=0)
    failed_action = Column(JSON, nullable=True)
    shell_rendered = Column(Boolean, nullable=True)
    console_summary = Column(JSON, nullable=True, default=list)
    network_summary = Column(JSON, nullable=True, default=list)
    dom_excerpt = Column(String, nullable=True)
    signature_input = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=_utcnow)


class Artifact(Base):
    __tablename__ = "artifact"

    id = Column(String, primary_key=True)
    result_id = Column(String, nullable=False)
    type = Column(String, nullable=False)
    storage_key = Column(String, nullable=False)
    bytes = Column(Integer, nullable=True)
    expires_at = Column(DateTime, nullable=True)


class FailureCluster(Base):
    __tablename__ = "failure_cluster"

    id = Column(String, primary_key=True)
    run_id = Column(String, nullable=False)
    signature_hash = Column(String, nullable=False)
    severity = Column(String, nullable=False)
    occurrences = Column(Integer, nullable=False)
    exemplar_result_id = Column(String, nullable=False)
    affected = Column(JSON, nullable=False, default=list)
    bundle = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, nullable=False, default=_utcnow)


def make_engine_and_sessionmaker(database_url: str):
    connect_args = {}
    if database_url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    engine = create_engine(database_url, connect_args=connect_args)
    session_local = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    return engine, session_local
