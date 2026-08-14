from conftest import create_run, finalize, ingest, result_payload, sig_input

STUDIO = {
    "name": "studio",
    "base_url_default": "https://studio.example.test",
    "roles": [{"name": "user", "credential_ref": "QA_CRED_USER"}, {"name": "anon"}],
    "selectors": {"appShell": "#root", "gateText": "Please sign in"},
    "role_matrix": {"/": {"user": "render", "anon": "redirect"}},
    "routes": ["/", "/settings"],
}


def _create(client, body=None):
    r = client.post("/api/v1/projects", json=body or STUDIO)
    assert r.status_code == 201, r.text
    return r.json()


def test_default_project_seeded(client):
    projects = client.get("/api/v1/projects").json()
    fai = next(p for p in projects if p["name"] == "fai")
    assert fai["id"].startswith("prj_")
    assert fai["base_url_default"] == "https://app.example.test"
    assert fai["routes_count"] == 3
    role_names = {r["name"] for r in fai["roles"]}
    assert role_names == {"user", "anon"}


def test_create_project_with_routes(client):
    p = _create(client)
    assert p["id"].startswith("prj_")
    assert p["name"] == "studio"
    full = client.get("/api/v1/projects/studio").json()
    assert full["selectors"]["appShell"] == "#root"
    assert full["role_matrix"]["/"]["anon"] == "redirect"
    routes = client.get("/api/v1/routes", params={"project": "studio"}).json()
    assert {x["path"] for x in routes} == {"/", "/settings"}


def test_duplicate_project_name_is_409(client):
    _create(client)
    r = client.post("/api/v1/projects", json=STUDIO)
    assert r.status_code == 409
    assert r.headers["content-type"].startswith("application/problem+json")


def test_unknown_project_is_404(client):
    assert client.get("/api/v1/projects/nope").status_code == 404


def test_unsafe_project_name_rejected(client):
    for bad in ["../../etc", "has space", "UPPER", "semi;colon", "a" * 65, ""]:
        r = client.post("/api/v1/projects",
                        json={"name": bad, "base_url_default": "https://x.test"})
        assert r.status_code == 400, f"{bad!r} should be rejected"
        assert r.headers["content-type"].startswith("application/problem+json")


def test_unsafe_role_name_rejected(client):
    r = client.post("/api/v1/projects", json={
        "name": "okproj", "base_url_default": "https://x.test",
        "roles": [{"name": "../evil", "credential_ref": "QA_CRED_USER"}],
    })
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/problem+json")


def test_patch_replaces_routes_and_merges_config(client):
    _create(client)
    r = client.patch("/api/v1/projects/studio",
                     json={"routes": ["/", "/new"],
                           "base_url_default": "https://studio2.example.test"})
    assert r.status_code == 200
    routes = client.get("/api/v1/routes", params={"project": "studio"}).json()
    assert {x["path"] for x in routes} == {"/", "/new"}  # /settings replaced away
    full = client.get("/api/v1/projects/studio").json()
    assert full["base_url_default"] == "https://studio2.example.test"
    assert full["selectors"]["appShell"] == "#root"  # untouched fields survive


def test_route_isolation_between_projects(client):
    _create(client)  # studio also has "/"
    fai_routes = client.get("/api/v1/routes").json()  # default project
    assert {x["path"] for x in fai_routes} == {"/", "/campaigns/campaign-library",
                                               "/campaigns/reports"}
    # a path that exists only in fai is invalid for a studio run
    r = client.post("/api/v1/runs",
                    json={"project": "studio", "routes": ["/campaigns/reports"]})
    assert r.status_code == 400
    assert r.headers["content-type"].startswith("application/problem+json")


def test_runs_are_project_scoped(client):
    _create(client)
    r = client.post("/api/v1/runs", json={"project": "studio", "routes": ["ALL"]})
    assert r.status_code == 202
    run = client.get(f"/api/v1/runs/{r.json()['run_id']}").json()
    assert run["project"] == "studio"
    assert run["base_url"] == "https://studio.example.test"

    default_run_id = create_run(client)
    default_run = client.get(f"/api/v1/runs/{default_run_id}").json()
    assert default_run["project"] == "fai"


def test_rerun_inherits_project(client):
    _create(client)
    r = client.post("/api/v1/runs", json={"project": "studio", "routes": ["/"]})
    rid = r.json()["run_id"]
    ingest(client, rid, [result_payload("failed", route="/", role="user",
                                        signature_input=sig_input())])
    finalize(client, rid)
    rerun = client.post(f"/api/v1/runs/{rid}/rerun", json={"scope": "failed"})
    new_run = client.get(f"/api/v1/runs/{rerun.json()['run_id']}").json()
    assert new_run["project"] == "studio"


def test_build_spawn_env_carries_project_payload(client, app, settings):
    import json

    from app.db import Project, TestRun
    from app.services.runner import build_spawn_env

    _create(client)
    r = client.post("/api/v1/runs", json={"project": "studio", "routes": ["ALL"]})
    run_id = r.json()["run_id"]
    with app.state.SessionLocal() as session:
        run = session.get(TestRun, run_id)
        project = session.query(Project).filter_by(name="studio").one()
        env = build_spawn_env(run, project, settings)

    assert env["QA_RUN_PROJECT"] == "studio"
    assert env["QA_RUN_BASE_URL"] == "https://studio.example.test"
    assert json.loads(env["QA_RUN_SELECTORS"])["appShell"] == "#root"
    assert json.loads(env["QA_RUN_ROLE_MATRIX"])["/"]["user"] == "render"
    roles = json.loads(env["QA_RUN_ROLES_CONFIG"])
    assert {"name": "user", "credential_ref": "QA_CRED_USER"} in roles


def test_run_without_roles_defaults_to_project_roles(client, app, settings):
    import json

    from app.db import Project, TestRun
    from app.services.runner import build_spawn_env

    _create(client)
    r = client.post("/api/v1/runs", json={"project": "studio", "routes": ["ALL"]})
    with app.state.SessionLocal() as session:
        run = session.get(TestRun, r.json()["run_id"])
        project = session.query(Project).filter_by(name="studio").one()
        env = build_spawn_env(run, project, settings)
    # an empty roles list would generate zero matrix tests on the worker
    assert json.loads(env["QA_RUN_ROLES"]) == ["user", "anon"]


def test_capabilities_lists_projects(client):
    _create(client)
    caps = client.get("/api/v1/capabilities").json()
    assert set(caps["projects"]) >= {"fai", "studio"}
