"""Authenticated artifact usage and cleanup operator endpoints."""

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.deps import get_session, get_settings, require_auth
from app.services.artifact_cleanup import artifact_usage, cleanup_artifacts
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


@router.get("/maintenance/artifacts")
def get_artifact_maintenance_status(
    request: Request,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Expose aggregate usage and the latest cleanup summary without filenames."""
    return {
        "usage": artifact_usage(session, settings),
        "limits": {
            "max_artifacts_per_result": settings.evidence_max_artifacts_per_result,
            "max_bytes_per_result": settings.evidence_max_artifact_bytes_per_result,
            "max_bytes_per_run": settings.evidence_max_artifact_bytes_per_run,
            "project_quota_bytes": settings.evidence_project_quota_bytes,
            "min_free_disk_bytes": settings.evidence_min_free_disk_bytes,
        },
        "last_cleanup": getattr(request.app.state, "last_artifact_cleanup", None),
    }


@router.post("/maintenance/artifacts/cleanup")
def run_artifact_cleanup(
    request: Request,
    dry_run: bool = Query(default=False),
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Run the same deterministic reconciliation used by scheduled cleanup and CLI."""
    summary = cleanup_artifacts(session, settings, dry_run=dry_run)
    request.app.state.last_artifact_cleanup = summary
    return summary
