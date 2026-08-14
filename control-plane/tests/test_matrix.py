from conftest import ingest, result_payload


def test_matrix_unknown_project_404(client):
    r = client.get("/api/v1/matrix", params={"project": "nope"})
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")


def test_matrix_merges_expectations_and_actuals(client):
    r = client.post("/api/v1/projects", json={
        "name": "matrixproj",
        "base_url_default": "https://matrix.example.test",
        "roles": [{"name": "user", "credential_ref": "QA_CRED_USER"}, {"name": "anon"}],
        "role_matrix": {
            "/": {"user": "render", "anon": "render"},
            "/admin": {"user": "render", "anon": "redirect"},
        },
        "routes": ["/", "/admin"],
    })
    assert r.status_code == 201, r.text

    run = client.post("/api/v1/runs", json={"project": "matrixproj", "routes": ["ALL"]})
    run_id = run.json()["run_id"]
    ingest(client, run_id, [
        result_payload("passed", route="/", role="user"),
        result_payload("passed", route="/", role="anon"),
        result_payload("failed", route="/admin", role="user"),
    ])
    finalize_resp = client.post(f"/api/v1/internal/runs/{run_id}/finalize", json={"status": "completed"})
    assert finalize_resp.status_code == 200

    matrix = client.get("/api/v1/matrix", params={"project": "matrixproj"}).json()
    by_path = {row["path"]: row for row in matrix}

    assert by_path["/"]["expectations"] == {"user": "render", "anon": "render"}
    assert by_path["/"]["actuals"] == {"user": "passed", "anon": "passed"}
    assert by_path["/"]["source"] == "config"

    assert by_path["/admin"]["expectations"] == {"user": "render", "anon": "redirect"}
    assert by_path["/admin"]["actuals"] == {"user": "failed", "anon": None}


def test_matrix_only_reflects_latest_completed_run(client):
    client.post("/api/v1/projects", json={
        "name": "matrixproj2",
        "base_url_default": "https://matrix2.example.test",
        "role_matrix": {"/": {"user": "render"}},
        "routes": ["/"],
    })

    run1 = client.post("/api/v1/runs", json={"project": "matrixproj2", "routes": ["ALL"]})
    rid1 = run1.json()["run_id"]
    ingest(client, rid1, [result_payload("failed", route="/", role="user")])
    client.post(f"/api/v1/internal/runs/{rid1}/finalize", json={"status": "completed"})

    run2 = client.post("/api/v1/runs", json={"project": "matrixproj2", "routes": ["ALL"]})
    rid2 = run2.json()["run_id"]
    ingest(client, rid2, [result_payload("passed", route="/", role="user")])
    client.post(f"/api/v1/internal/runs/{rid2}/finalize", json={"status": "completed"})

    matrix = client.get("/api/v1/matrix", params={"project": "matrixproj2"}).json()
    row = next(r for r in matrix if r["path"] == "/")
    assert row["actuals"]["user"] == "passed"


def test_matrix_defaults_to_fai_project_and_falls_back_to_yaml(client):
    matrix = client.get("/api/v1/matrix").json()
    paths = {row["path"] for row in matrix}
    # fai has an empty role_matrix in test settings, and the real role-matrix.yaml
    # fallback path won't exist relative to a tmp settings dir, so it tolerates
    # a missing file and falls back to {} rather than raising.
    assert isinstance(matrix, list)
    for row in matrix:
        assert set(row.keys()) == {"path", "source", "expectations", "actuals"}


def test_matrix_falls_back_to_role_matrix_yaml_for_fai(client, settings):
    from pathlib import Path

    yaml_path = Path(settings.role_matrix_fallback_path)
    yaml_path.parent.mkdir(parents=True, exist_ok=True)
    yaml_path.write_text(
        "/:\n  user: render\n  anon: redirect\n"
    )

    matrix = client.get("/api/v1/matrix", params={"project": "fai"}).json()
    row = next(r for r in matrix if r["path"] == "/")
    assert row["expectations"] == {"user": "render", "anon": "redirect"}
    assert row["actuals"] == {"user": None, "anon": None}
