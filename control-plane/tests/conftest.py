import pytest
from fastapi.testclient import TestClient


def make_settings(tmp_path, **overrides):
    from app.settings import Settings

    (tmp_path / "routes.yaml").write_text(
        "routes:\n"
        "  - /\n"
        "  - /dashboard/analytics\n"
        "  - /dashboard/reports\n"
    )
    defaults = dict(
        api_token="testtoken",
        signing_secret="testsign",
        webhook_secret="whsecret",
        webhook_urls="",
        base_url_default="https://app.example.test",
        target_allowed_origins="https://*.test",
        database_url=f"sqlite:///{tmp_path / 'qa.db'}",
        artifacts_dir=str(tmp_path / "artifacts"),
        routes_config=str(tmp_path / "routes.yaml"),
        runner_mode="manual",
        roles="user,anon",
        credentials_file=str(tmp_path / ".env.credentials"),
        role_matrix_fallback_path=str(tmp_path / "role-matrix.yaml"),
        scheduler_enabled=False,
        cleanup_enabled=False,
    )
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture()
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture()
def app(settings):
    from app.main import create_app

    return create_app(settings)


@pytest.fixture()
def client(app):
    c = TestClient(app)
    c.headers["Authorization"] = "Bearer testtoken"
    return c


def result_payload(status="passed", route="/", role="user", **kw):
    base = {
        "test_name": f"matrix {route} as {role} -> render",
        "test_file": "tests/matrix.spec.ts:1",
        "route_path": route,
        "role": role,
        "browser": "chromium",
        "viewport": "1440x900",
        "status": status,
        "duration_ms": 1200,
        "flaky": False,
        "reruns_attempted": 0,
        "reruns_failed": 0,
        "failed_action": None,
        "shell_rendered": None,
        "console_summary": [],
        "network_summary": [],
        "dom_excerpt": None,
        "signature_input": None,
        "artifacts": [],
    }
    base.update(kw)
    return base


def sig_input(error="Timed out waiting for locator <n>ms", frame="bundle/index.js:1:88214",
              route="/", role="user"):
    return {"normalized_error": error, "top_stack_frame": frame, "route": route, "role": role}


def create_run(client, routes=None, roles=None, **body_extra):
    body = {"routes": routes or ["ALL"], "roles": roles or ["user", "anon"]}
    body.update(body_extra)
    r = client.post("/api/v1/runs", json=body)
    assert r.status_code == 202, r.text
    return r.json()["run_id"]


def ingest(client, run_id, results):
    r = client.post(f"/api/v1/internal/runs/{run_id}/results", json=results)
    assert r.status_code == 204, r.text


def finalize(client, run_id, status="completed", detail=None):
    body = {"status": status}
    if detail:
        body["detail"] = detail
    r = client.post(f"/api/v1/internal/runs/{run_id}/finalize", json=body)
    assert r.status_code == 200, r.text
    return r.json()
