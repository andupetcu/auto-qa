import hashlib
import hmac
import json

import httpx
from fastapi.testclient import TestClient

from conftest import create_run, finalize, make_settings


def test_sign_body_is_hmac_sha256_hex():
    from app.services.events import sign_body

    body = b'{"event":"run.completed"}'
    expected = hmac.new(b"whsecret", body, hashlib.sha256).hexdigest()
    assert sign_body("whsecret", body) == f"sha256={expected}"


def test_webhook_delivery_envelope_and_signature(tmp_path):
    from app.main import create_app

    received = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return httpx.Response(200)

    settings = make_settings(tmp_path, webhook_urls="http://hermes.test/hook")
    app = create_app(settings, webhook_transport=httpx.MockTransport(handler))
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer testtoken"

    rid = create_run(client)
    client.post(f"/api/v1/internal/runs/{rid}/started")
    finalize(client, rid)

    events = [json.loads(r.content)["event"] for r in received]
    assert events == ["run.started", "run.completed"]

    for req in received:
        assert req.headers["X-QA-Event"] in ("run.started", "run.completed")
        assert req.headers["X-QA-Delivery"]
        expected = hmac.new(b"whsecret", req.content, hashlib.sha256).hexdigest()
        assert req.headers["X-QA-Signature"] == f"sha256={expected}"
        env = json.loads(req.content)
        assert set(env) >= {"event", "delivery_id", "sequence", "emitted_at", "data"}

    started = json.loads(received[0].content)
    assert started["data"]["run_id"] == rid
    assert started["data"]["base_url"] == "https://app.example.test"
    completed = json.loads(received[1].content)
    assert completed["data"]["totals"] == {"passed": 0, "failed": 0,
                                           "skipped": 0, "flaky": 0}
    assert completed["sequence"] > started["sequence"]


def test_no_webhook_urls_means_no_delivery(tmp_path):
    from app.main import create_app

    received = []
    settings = make_settings(tmp_path, webhook_urls="")
    app = create_app(settings, webhook_transport=httpx.MockTransport(
        lambda r: received.append(r) or httpx.Response(200)))
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer testtoken"
    finalize(client, create_run(client))
    assert received == []
