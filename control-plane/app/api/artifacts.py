"""Public signed artifact download endpoint with immutable-byte verification."""

import hashlib
import json
import mimetypes
import time
from pathlib import Path

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from app.deps import get_settings
from app.settings import Settings
from app.services.evidence import artifact_metadata_path
from app.problems import ProblemException
from app.services.signing import verify_signature

router = APIRouter()


@router.get("/artifacts/{storage_key:path}", include_in_schema=False)
def serve_artifact(
    storage_key: str,
    exp: int,
    sig: str,
    settings: Settings = Depends(get_settings),
):
    if not verify_signature(settings, storage_key, exp, sig):
        raise ProblemException(403, "Invalid artifact signature", "Signature is invalid")
    if int(time.time()) > exp:
        raise ProblemException(403, "Invalid artifact signature", "Signature is expired")
    base = Path(settings.artifacts_dir).resolve()
    path = (base / storage_key).resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise ProblemException(403, "Invalid artifact path", "Path traversal is not allowed")
    if not path.is_file():
        raise ProblemException(404, "Artifact not found", storage_key)

    sidecar = artifact_metadata_path(path)
    try:
        metadata = json.loads(sidecar.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ProblemException(
            403, "Artifact is not verified", "Only sanitized evidence may be downloaded"
        ) from exc
    if (
        not isinstance(metadata, dict)
        or metadata.get("state") != "redacted"
        or metadata.get("raw_variant_retrievable") is not False
        or metadata.get("redaction_version") != "evidence-redaction-v1"
    ):
        raise ProblemException(
            403, "Artifact is not verified", "Only sanitized evidence may be downloaded"
        )

    content = path.read_bytes()
    if (
        metadata.get("_bytes") != len(content)
        or metadata.get("_sha256") != hashlib.sha256(content).hexdigest()
    ):
        raise ProblemException(
            409,
            "Artifact integrity failure",
            "The sanitized artifact changed after ingestion",
        )
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'inline; filename="{path.name}"'},
    )
