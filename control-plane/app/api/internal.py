from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import Artifact, Project, TestResult, TestRun
from app.deps import get_session, get_settings, require_auth
from app.ids import new_id
from app.problems import ProblemException
from app.services.artifact_quota import ArtifactQuotaTracker, require_evidence_disk_capacity
from app.services.clustering import cluster_run
from app.services.events import emit_webhook
from app.services.route_metadata import pathname_only
from app.services.evidence import (
    evidence_policy,
    prepare_artifact,
    redact_string,
    redact_value,
    validate_visual_artifact_set,
)
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


class ArtifactIngest(BaseModel):
    type: Literal[
        "trace",
        "screenshot",
        "screenshot_frame",
        "contact_sheet",
        "visual_manifest",
        "video",
        "har",
        "console",
    ]
    storage_key: str
    bytes: int | None = None


class ResultIngest(BaseModel):
    test_name: str
    test_file: str
    route_path: str | None = None
    role: str | None = None
    browser: str | None = None
    viewport: str | None = None
    status: Literal["passed", "failed", "skipped"]
    duration_ms: int | None = None
    flaky: bool = False
    reruns_attempted: int = 0
    reruns_failed: int = 0
    failed_action: dict | None = None
    shell_rendered: bool | None = None
    console_summary: list = Field(default_factory=list)
    network_summary: list = Field(default_factory=list)
    dom_excerpt: str | None = None
    signature_input: dict | None = None
    artifacts: list[ArtifactIngest] = Field(default_factory=list)


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
    run = _get_run_or_404(session, run_id)
    if run.status in TERMINAL_STATUSES:
        raise ProblemException(
            409, "Run is terminal", f"Cannot ingest results for {run.status} run"
        )

    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=settings.retention_full_days)
    policy = evidence_policy(settings)
    quota = ArtifactQuotaTracker.for_run(session, settings, run)
    if any(item.artifacts for item in results):
        require_evidence_disk_capacity(settings)

    for item in results:
        result_id = new_id("res")
        prepared_artifacts: list[tuple[ArtifactIngest, int]] = []
        for artifact in item.artifacts:
            _, actual_bytes = prepare_artifact(
                settings,
                run_id,
                artifact.type,
                artifact.storage_key,
                policy,
                result_id=result_id,
            )
            prepared_artifacts.append((artifact, actual_bytes))

        validate_visual_artifact_set(settings, prepared_artifacts)
        quota.reserve_result(
            len(prepared_artifacts),
            sum(actual_bytes for _, actual_bytes in prepared_artifacts),
        )
        session.add(
            TestResult(
                id=result_id,
                run_id=run_id,
                test_name=redact_string(item.test_name, policy),
                test_file=redact_string(item.test_file, policy),
                route_path=pathname_only(item.route_path),
                role=item.role,
                browser=item.browser,
                viewport=item.viewport,
                status=item.status,
                duration_ms=item.duration_ms,
                flaky=item.flaky,
                reruns_attempted=item.reruns_attempted,
                reruns_failed=item.reruns_failed,
                failed_action=redact_value(item.failed_action, policy),
                shell_rendered=item.shell_rendered,
                console_summary=redact_value(item.console_summary, policy),
                network_summary=redact_value(item.network_summary, policy),
                dom_excerpt=redact_string(item.dom_excerpt, policy) if item.dom_excerpt else None,
                signature_input=redact_value(item.signature_input, policy),
                created_at=now,
            )
        )
        for artifact, actual_bytes in prepared_artifacts:
            session.add(
                Artifact(
                    id=new_id("art"),
                    result_id=result_id,
                    type=artifact.type,
                    storage_key=artifact.storage_key,
                    bytes=actual_bytes,
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
    if run.status in TERMINAL_STATUSES:
        return {"status": run.status}
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
