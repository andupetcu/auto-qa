from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db import Artifact, Project, TestResult, TestRun
from app.deps import get_session, get_settings, require_auth
from app.ids import new_id
from app.problems import ProblemException
from app.services.clustering import cluster_run
from app.services.events import emit_webhook
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


class ArtifactIngest(BaseModel):
    type: str
    storage_key: str
    bytes: int | None = None


class ResultIngest(BaseModel):
    test_name: str
    test_file: str
    route_path: str | None = None
    role: str | None = None
    browser: str | None = None
    viewport: str | None = None
    status: str
    duration_ms: int | None = None
    flaky: bool = False
    reruns_attempted: int = 0
    reruns_failed: int = 0
    failed_action: dict | None = None
    shell_rendered: bool | None = None
    console_summary: list = []
    network_summary: list = []
    dom_excerpt: str | None = None
    signature_input: dict | None = None
    artifacts: list[ArtifactIngest] = []


class FinalizeBody(BaseModel):
    status: Literal["completed", "failed", "auth_expired"]
    detail: str | None = None


def _get_run_or_404(session: Session, run_id: str) -> TestRun:
    run = session.get(TestRun, run_id)
    if run is None:
        raise ProblemException(404, "Run not found", f"No run with id {run_id}")
    return run


def _project_name(session: Session, project_id: str | None) -> str | None:
    if project_id is None:
        return None
    project = session.get(Project, project_id)
    return project.name if project else None


TERMINAL_STATUSES = frozenset({"completed", "failed", "auth_expired", "canceled"})


class ProgressBody(BaseModel):
    phase: str | None = None
    done: int | None = None
    total: int | None = None
    current: str | None = None


@router.post("/runs/{run_id}/results", status_code=204)
def ingest_results(
    run_id: str,
    results: list[ResultIngest],
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    _get_run_or_404(session, run_id)

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=settings.retention_full_days)

    for item in results:
        result_id = new_id("res")
        session.add(
            TestResult(
                id=result_id,
                run_id=run_id,
                test_name=item.test_name,
                test_file=item.test_file,
                route_path=item.route_path,
                role=item.role,
                browser=item.browser,
                viewport=item.viewport,
                status=item.status,
                duration_ms=item.duration_ms,
                flaky=item.flaky,
                reruns_attempted=item.reruns_attempted,
                reruns_failed=item.reruns_failed,
                failed_action=item.failed_action,
                shell_rendered=item.shell_rendered,
                console_summary=item.console_summary,
                network_summary=item.network_summary,
                dom_excerpt=item.dom_excerpt,
                signature_input=item.signature_input,
                created_at=now,
            )
        )
        for art in item.artifacts:
            session.add(
                Artifact(
                    id=new_id("art"),
                    result_id=result_id,
                    type=art.type,
                    storage_key=art.storage_key,
                    bytes=art.bytes,
                    expires_at=expires_at,
                )
            )

    session.commit()
    return Response(status_code=204)


@router.post("/runs/{run_id}/started")
def mark_started(
    run_id: str,
    request: Request,
    session: Session = Depends(get_session),
):
    run = _get_run_or_404(session, run_id)
    run.status = "running"
    run.started_at = datetime.now(timezone.utc)
    session.commit()

    emit_webhook(
        request.app,
        run.id,
        "run.started",
        {
            "run_id": run.id,
            "project": _project_name(session, run.project_id),
            "trigger": run.trigger,
            "base_url": run.base_url,
            "app_version": run.app_version,
        },
    )
    return {"status": run.status}


@router.post("/runs/{run_id}/progress")
def update_progress(
    run_id: str,
    body: ProgressBody,
    session: Session = Depends(get_session),
):
    run = _get_run_or_404(session, run_id)
    if run.status in TERMINAL_STATUSES:
        return {"status": run.status}  # ignore stragglers after the run finished
    prog = dict(run.progress or {})
    for field in ("phase", "done", "total", "current"):
        value = getattr(body, field)
        if value is not None:
            prog[field] = value
    prog["updated_at"] = datetime.now(timezone.utc).isoformat()
    run.progress = prog
    session.commit()
    return {"status": run.status}


@router.post("/runs/{run_id}/finalize")
def finalize_run(
    run_id: str,
    body: FinalizeBody,
    request: Request,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    run = _get_run_or_404(session, run_id)

    # a run canceled mid-flight must not be resurrected by a late worker finalize
    if run.status in TERMINAL_STATUSES:
        return {"status": run.status, "totals": run.totals}

    results = session.query(TestResult).filter_by(run_id=run_id).all()
    totals = {"passed": 0, "failed": 0, "skipped": 0, "flaky": 0}
    for r in results:
        if r.flaky:
            totals["flaky"] += 1
        elif r.status == "passed":
            totals["passed"] += 1
        elif r.status == "failed":
            totals["failed"] += 1
        elif r.status == "skipped":
            totals["skipped"] += 1

    run.status = body.status
    run.ended_at = datetime.now(timezone.utc)
    run.totals = totals
    run.detail = body.detail
    session.commit()

    n_bundles = cluster_run(session, run, settings)
    session.commit()

    project_name = _project_name(session, run.project_id)
    if body.status == "completed":
        emit_webhook(
            request.app,
            run.id,
            "run.completed",
            {
                "run_id": run.id,
                "project": project_name,
                "totals": totals,
                "bundles": n_bundles,
                "parent_run_id": run.parent_run_id,
            },
        )
    else:
        emit_webhook(
            request.app,
            run.id,
            "run.failed",
            {"run_id": run.id, "project": project_name, "status": run.status,
             "detail": run.detail},
        )

    return {"status": run.status, "totals": totals}
