import time
from pathlib import Path

from fastapi.testclient import TestClient


def _write_artifact(settings, key: str, content: bytes = b"trace-bytes"):
    p = Path(settings.artifacts_dir) / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(content)
    return p


def test_signed_url_roundtrip(app, settings):
    from app.services.signing import signed_url_for

    _write_artifact(settings, "runs/run_x/t1/trace.zip")
    url = signed_url_for(settings, "runs/run_x/t1/trace.zip")
    assert url.startswith("/artifacts/")
    c = TestClient(app)  # signed URLs are the only unauthenticated path
    r = c.get(url)
    assert r.status_code == 200
    assert r.content == b"trace-bytes"


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
