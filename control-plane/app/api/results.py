from datetime import timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.db import Artifact, TestResult
from app.deps import get_session, get_settings, require_auth
from app.problems import ProblemException
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

    return {
        "type": "har",
        "url": signed_url_for(settings, artifact.storage_key, expires_at=_to_unix(artifact.expires_at)),
        "bytes": artifact.bytes,
        "expires_at": artifact.expires_at.isoformat() if artifact.expires_at else None,
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
