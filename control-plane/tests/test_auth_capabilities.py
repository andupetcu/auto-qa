"""Authentication boundary and capability-version contract tests."""

from fastapi.testclient import TestClient


def test_requests_without_token_are_rejected(app):
    c = TestClient(app)
    assert c.get("/api/v1/capabilities").status_code == 401
    assert c.get("/api/v1/runs").status_code == 401


def test_wrong_token_rejected(app):
    c = TestClient(app)
    c.headers["Authorization"] = "Bearer nope"
    assert c.get("/api/v1/capabilities").status_code == 401


def test_capabilities_shape(client):
    r = client.get("/api/v1/capabilities")
    assert r.status_code == 200
    caps = r.json()
    for t in ("trace", "har", "console", "screenshot", "video"):
        assert t in caps["artifact_types"]
    assert caps["version"] == "0.2"
    assert caps["roles"] == ["user", "anon"]
    # the New-run drawer sources these instead of hardcoding them
    assert "chromium" in caps["browsers"]
    assert set(caps["browsers"]) <= {"chromium", "firefox", "webkit"}
    assert all("x" in v for v in caps["viewports"])
