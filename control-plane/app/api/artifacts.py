"""Unauthenticated signed-URL artifact serving. Never behind the bearer-token dependency."""
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from app.problems import ProblemException
from app.services.signing import verify_signature

router = APIRouter()


@router.get("/artifacts/{key:path}")
def get_artifact(key: str, exp: int, sig: str, request: Request):
    settings = request.app.state.settings

    if not verify_signature(settings, key, exp, sig):
        raise ProblemException(403, "Forbidden", "Invalid signature")
    if int(time.time()) > exp:
        raise ProblemException(403, "Forbidden", "Signature expired")

    base_dir = Path(settings.artifacts_dir).resolve()
    target = (base_dir / key).resolve()
    try:
        target.relative_to(base_dir)
    except ValueError:
        raise ProblemException(403, "Forbidden", "Path traversal rejected")

    if not target.is_file():
        raise ProblemException(404, "Not Found", "Artifact file not found")

    return FileResponse(target)
