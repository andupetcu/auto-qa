import json
from datetime import timezone
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import Artifact, TestResult
from app.deps import get_session, get_settings, require_auth
from app.problems import ProblemException
from app.services.evidence import read_artifact_metadata
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
    """Project the immutable v1 manifest with signed links for retained visual files."""
    _get_result_or_404(session, result_id)
    artifacts = session.query(Artifact).filter_by(result_id=result_id).all()
    manifest_artifact = next(
        (artifact for artifact in artifacts if artifact.type == "visual_manifest"), None
    )
    if manifest_artifact is None:
        return {
            "status": "not_captured",
            "manifest": None,
            "frames": [],
            "finalScreenshot": None,
            "contactSheet": None,
            "warnings": [],
        }

    root = Path(settings.artifacts_dir).resolve()
    manifest_path = (root / manifest_artifact.storage_key).resolve()
    try:
        manifest_path.relative_to(root)
        manifest = json.loads(manifest_path.read_text())
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        raise ProblemException(
            409,
            "Visual evidence unavailable",
            "The persisted visual manifest is missing or invalid",
        ) from exc

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
        "manifest": manifest,
        "manifestArtifact": _serialize_artifact(manifest_artifact, settings),
        "frames": frames,
        "finalScreenshot": with_artifact(manifest.get("finalScreenshot")),
        "contactSheet": with_artifact(manifest.get("contactSheet")),
        "warnings": manifest.get("warnings", []),
    }
