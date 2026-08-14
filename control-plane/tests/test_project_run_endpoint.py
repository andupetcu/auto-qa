def _create(client, name="runner-proj"):
    r = client.post("/api/v1/projects", json={
        "name": name, "base_url_default": "https://runner.example.test",
        "routes": ["/"],
    })
    assert r.status_code == 201, r.text
    return r.json()


def test_post_project_run_returns_202_and_scopes_to_project(client):
    project = _create(client)
    r = client.post(f"/api/v1/projects/{project['name']}/run", json={})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["run_id"].startswith("run_")
    assert body["status"] == "queued"

    run = client.get(f"/api/v1/runs/{body['run_id']}").json()
    assert run["project"] == project["name"]
    assert run["base_url"] == "https://runner.example.test"
    assert run["requested_routes"] == ["ALL"]
    assert run["trigger"] == "manual"


def test_post_project_run_by_id_accepts_overrides(client):
    project = _create(client, name="runner-proj2")
    r = client.post(f"/api/v1/projects/{project['id']}/run", json={
        "routes": ["/"], "base_url": "https://override.example.test",
        "app_version": "v9", "trigger": "schedule",
    })
    assert r.status_code == 202, r.text
    run = client.get(f"/api/v1/runs/{r.json()['run_id']}").json()
    assert run["project"] == project["name"]
    assert run["base_url"] == "https://override.example.test"
    assert run["app_version"] == "v9"
    assert run["trigger"] == "schedule"
    assert run["requested_routes"] == ["/"]


def test_post_project_run_unknown_project_404(client):
    r = client.post("/api/v1/projects/does-not-exist/run", json={})
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
