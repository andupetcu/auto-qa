import hashlib
import json
import time
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient


def _write_artifact(
    settings,
    key: str,
    content: bytes = b"trace-bytes",
    *,
    redaction_version: str = "evidence-redaction-v2",
):
    p = Path(settings.artifacts_dir) / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    p.with_name(p.name + ".metadata.json").write_text(json.dumps({
        "redaction_version": redaction_version,
        "state": "redacted",
        "raw_variant_retrievable": False,
        "_sha256": hashlib.sha256(content).hexdigest(),
        "_bytes": len(content),
    }))
    return p


def _register_artifact(app, key: str, artifact_type: str) -> None:
    from app.db import Artifact

    with app.state.SessionLocal() as session:
        session.add(
            Artifact(
                id=f"art_{uuid4().hex}",
                result_id="res_legacy_fixture",
                type=artifact_type,
                storage_key=key,
                bytes=0,
            )
        )
        session.commit()


def test_signed_url_roundtrip(app, settings):
    from app.services.signing import signed_url_for

    _write_artifact(settings, "runs/run_x/t1/trace.zip")
    url = signed_url_for(settings, "runs/run_x/t1/trace.zip")
    assert url.startswith("/artifacts/")
    c = TestClient(app)  # signed URLs are the only unauthenticated path
    r = c.get(url)
    assert r.status_code == 200
    assert r.content == b"trace-bytes"


@pytest.mark.parametrize("key", ["network.json", "network.har.json", "network.HAR"])
def test_legacy_v1_har_is_not_downloadable_regardless_of_filename(
    app, settings, key
):
    from app.services.signing import signed_url_for

    _write_artifact(settings, key, b'{"log":{}}', redaction_version="evidence-redaction-v1")
    _register_artifact(app, key, "har")
    response = TestClient(app).get(signed_url_for(settings, key))
    assert response.status_code == 403
    assert response.json()["title"] == "Artifact is not verified"


def test_legacy_v1_non_har_evidence_with_har_suffix_remains_downloadable(app, settings):
    from app.services.signing import signed_url_for

    key = "runs/run_x/t1/non-har-evidence.har"
    _write_artifact(settings, key, redaction_version="evidence-redaction-v1")
    _register_artifact(app, key, "trace")
    response = TestClient(app).get(signed_url_for(settings, key))
    assert response.status_code == 200
    assert response.content == b"trace-bytes"


def test_unreferenced_legacy_v1_artifact_fails_closed(app, settings):
    from app.services.signing import signed_url_for

    key = "runs/run_x/t1/unreferenced.json"
    _write_artifact(settings, key, redaction_version="evidence-redaction-v1")
    response = TestClient(app).get(signed_url_for(settings, key))
    assert response.status_code == 403
    assert response.json()["title"] == "Artifact is not verified"


def test_tampered_signature_rejected(app, settings):
    from app.services.signing import signed_url_for

    _write_artifact(settings, "runs/run_x/t1/trace.zip")
    url = signed_url_for(settings, "runs/run_x/t1/trace.zip")
    bad = url.replace("sig=", "sig=0000")
    assert TestClient(app).get(bad).status_code == 403


def test_expired_url_rejected(app, settings):
    from app.services.signing import signed_url_for

    _write_artifact(settings, "runs/run_x/t1/trace.zip")
    url = signed_url_for(settings, "runs/run_x/t1/trace.zip",
                         expires_at=int(time.time()) - 10)
    assert TestClient(app).get(url).status_code == 403


def test_path_traversal_rejected(app, settings):
    from app.services.signing import signed_url_for

    url = signed_url_for(settings, "../secrets.txt")
    assert TestClient(app).get(url).status_code in (403, 404)


def test_missing_file_is_404(app, settings):
    from app.services.signing import signed_url_for

    url = signed_url_for(settings, "runs/run_x/none/trace.zip")
    assert TestClient(app).get(url).status_code == 404


def test_unsigned_sanitization_state_is_not_downloadable(app, settings):
    from app.services.signing import signed_url_for

    path = _write_artifact(settings, "runs/run_x/t1/evidence.txt", b"safe")
    path.with_name(path.name + ".metadata.json").unlink()
    response = TestClient(app).get(signed_url_for(settings, "runs/run_x/t1/evidence.txt"))
    assert response.status_code == 403
    assert response.json()["title"] == "Artifact is not verified"


def test_post_ingestion_mutation_invalidates_existing_signed_url(app, settings):
    from app.services.signing import signed_url_for

    path = _write_artifact(settings, "runs/run_x/t1/evidence.txt", b"sanitized")
    url = signed_url_for(settings, "runs/run_x/t1/evidence.txt")
    path.write_bytes(b"later-secret-mutation")
    response = TestClient(app).get(url)
    assert response.status_code == 409
    assert response.json()["title"] == "Artifact integrity failure"
    assert b"later-secret-mutation" not in response.content


def test_tampered_safety_sidecar_is_not_trusted(app, settings):
    from app.services.signing import signed_url_for

    path = _write_artifact(settings, "runs/run_x/t1/evidence.txt", b"sanitized")
    sidecar = path.with_name(path.name + ".metadata.json")
    metadata = json.loads(sidecar.read_text())
    metadata["raw_variant_retrievable"] = True
    sidecar.write_text(json.dumps(metadata))
    response = TestClient(app).get(signed_url_for(settings, "runs/run_x/t1/evidence.txt"))
    assert response.status_code == 403
