"""Authenticated result evidence and bounded diagnostics projections."""

import json
from datetime import timezone
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import Artifact, TestResult
from app.deps import get_session, get_settings, require_auth
from app.problems import ProblemException
from app.services.evidence import read_artifact_metadata
from app.services.route_metadata import pathname_only
from app.services.signing import signed_url_for
from app.settings import Settings

router = APIRouter(dependencies=[Depends(require_auth)])


def _get_result_or_404(session: Session, result_id: str) -> TestResult:
    result = session.get(TestResult, result_id)
    if result is None:
        raise ProblemException(404, "Result not found", f"No result with id {result_id}")
    return result


def _to_unix(dt):
    if dt is None:
        return None
    # SQLite returns naive datetimes; they were stored as UTC — reattach before
    # .timestamp() or the signed-URL expiry shifts by the host's UTC offset
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _serialize_artifact(art: Artifact, settings: Settings) -> dict:
    return {
        "type": art.type,
        "url": signed_url_for(settings, art.storage_key, expires_at=_to_unix(art.expires_at)),
        "bytes": art.bytes,
        "expires_at": art.expires_at.isoformat() if art.expires_at else None,
        "metadata": read_artifact_metadata(settings, art.storage_key),
    }


def _load_visual_manifest(
    session: Session, result_id: str, settings: Settings
) -> tuple[dict | None, Artifact | None]:
    artifact = (
        session.query(Artifact)
        .filter_by(result_id=result_id, type="visual_manifest")
        .first()
    )
    if artifact is None:
        return None, None
    root = Path(settings.artifacts_dir).resolve()
    manifest_path = (root / artifact.storage_key).resolve()
    try:
        manifest_path.relative_to(root)
        manifest = json.loads(manifest_path.read_text())
        if not isinstance(manifest, dict):
            raise ValueError("manifest is not an object")
        manifest["route"] = pathname_only(manifest.get("route"))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise ProblemException(
            409,
            "Visual evidence unavailable",
            "The persisted visual manifest is missing or invalid",
        ) from exc
    return manifest, artifact


@router.get("/results/{result_id}/console")
def get_console(
    result_id: str,
    level: str = "error",
    limit: int | None = None,
    session: Session = Depends(get_session),
):
    result = _get_result_or_404(session, result_id)
    rows = result.console_summary or []
    if level != "all":
        rows = [r for r in rows if r.get("level") == level]
    if limit is not None:
        rows = rows[:limit]
    return rows


@router.get("/results/{result_id}/har")
def get_har(
    result_id: str,
    failures_only: bool = True,
    body_bytes: int | None = None,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    result = _get_result_or_404(session, result_id)

    if failures_only:
        return result.network_summary or []

    artifact = (
        session.query(Artifact).filter_by(result_id=result_id, type="har").first()
    )
    if artifact is None:
        raise ProblemException(404, "No har artifact", f"No har artifact for result {result_id}")

    return _serialize_artifact(artifact, settings)


@router.get("/results/{result_id}/network-summary")
def get_network_summary(
    result_id: str,
    session: Session = Depends(get_session),
):
    """Return a bounded, query-free network collector summary and abnormalities."""
    result = _get_result_or_404(session, result_id)
    rows = result.network_summary or []
    collector = next(
        (row for row in rows if isinstance(row, dict) and row.get("kind") == "summary"),
        None,
    )
    entries = [
        row
        for row in rows
        if isinstance(row, dict) and row.get("kind") != "summary"
    ]
    return {
        "collector_status": (
            collector.get("collector_status", "completed")
            if collector
            else "not_captured"
        ),
        "summary": collector,
        "count": len(entries),
        "entries": entries,
    }


@router.get("/results/{result_id}/runtime-summary")
def get_runtime_summary(
    result_id: str,
    session: Session = Depends(get_session),
):
    """Report browser runtime collector health independently from event count."""
    result = _get_result_or_404(session, result_id)
    entries = [row for row in (result.console_summary or []) if isinstance(row, dict)]
    artifact = (
        session.query(Artifact).filter_by(result_id=result_id, type="console").first()
    )
    counts: dict[str, int] = {}
    for row in entries:
        key = str(row.get("kind") or row.get("level") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    return {
        "collector_status": "completed" if artifact else "not_captured",
        "counts": counts,
        "count": len(entries),
        "entries": entries,
    }


@router.get("/results/{result_id}/readiness-summary")
def get_readiness_summary(
    result_id: str,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Project the immutable readiness verdict without signed image payloads."""
    _get_result_or_404(session, result_id)
    manifest, _ = _load_visual_manifest(session, result_id, settings)
    if manifest is None:
        return {
            "status": "not_captured",
            "evidence_state": "not_applicable",
            "manifest_schema": None,
            "route": None,
            "readiness": None,
        }
    readiness = manifest.get("readiness")
    return {
        "status": (
            readiness.get("status", "unknown")
            if isinstance(readiness, dict)
            else "unknown"
        ),
        "evidence_state": manifest.get("evidenceState", "captured_unsettled"),
        "manifest_schema": manifest.get("schemaVersion"),
        "route": manifest.get("route"),
        "readiness": readiness,
    }


@router.get("/results/{result_id}/artifacts")
def get_artifacts(
    result_id: str,
    types: str | None = None,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    _get_result_or_404(session, result_id)
    rows = session.query(Artifact).filter_by(result_id=result_id).all()
    if types:
        wanted = {t.strip() for t in types.split(",") if t.strip()}
        rows = [a for a in rows if a.type in wanted]
    return [_serialize_artifact(a, settings) for a in rows]


@router.get("/results/{result_id}/visual-evidence")
def get_visual_evidence(
    result_id: str,
    session: Session = Depends(get_session),
    settings: Settings = Depends(get_settings),
):
    """Project versioned manifests with signed links for retained visual files."""
    _get_result_or_404(session, result_id)
    manifest, manifest_artifact = _load_visual_manifest(session, result_id, settings)
    artifacts = session.query(Artifact).filter_by(result_id=result_id).all()
    if manifest_artifact is None or manifest is None:
        return {
            "status": "not_captured",
            "manifest": None,
            "frames": [],
            "finalScreenshot": None,
            "contactSheet": None,
            "warnings": [],
        }

    by_name = {Path(artifact.storage_key).name: artifact for artifact in artifacts}

    def with_artifact(descriptor):
        if not isinstance(descriptor, dict):
            return None
        artifact = by_name.get(descriptor.get("filename"))
        return {
            **descriptor,
            "artifact": _serialize_artifact(artifact, settings) if artifact else None,
        }

    frames = [with_artifact(frame) for frame in manifest.get("frames", [])]
    frames = sorted(
        (frame for frame in frames if frame is not None),
        key=lambda frame: frame.get("index", 0),
    )
    return {
        "status": "captured",
        "evidenceState": manifest.get("evidenceState", "captured_unsettled"),
        "readiness": manifest.get("readiness"),
        "manifest": manifest,
        "manifestArtifact": _serialize_artifact(manifest_artifact, settings),
        "frames": frames,
        "finalScreenshot": with_artifact(manifest.get("finalScreenshot")),
        "contactSheet": with_artifact(manifest.get("contactSheet")),
        "warnings": manifest.get("warnings", []),
    }
