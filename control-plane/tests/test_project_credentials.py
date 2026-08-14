import stat


def _create_project(client, name="credproj"):
    r = client.post("/api/v1/projects", json={
        "name": name, "base_url_default": "https://cred.example.test",
    })
    assert r.status_code == 201, r.text
    return r.json()


def test_put_credentials_writes_secrets_file(client, settings):
    project = _create_project(client)
    r = client.put(f"/api/v1/projects/{project['name']}/credentials", json={
        "username": "qa@example.test",
        "password": "s3cret!",
        "totp_seed": "JBSWY3DPEHPK3PXP",
    })
    assert r.status_code in (200, 204), r.text

    from pathlib import Path

    path = Path(settings.credentials_file)
    assert path.exists()
    content = path.read_text()
    prefix = f"QA_PRJ_{project['id'].upper()}"
    assert f"{prefix}_USER_EMAIL=qa@example.test" in content
    assert f"{prefix}_PASSWORD=s3cret!" in content
    assert f"{prefix}_TOTP_SEED=JBSWY3DPEHPK3PXP" in content

    mode = stat.S_IMODE(path.stat().st_mode)
    assert mode == 0o600


def test_put_credentials_without_totp(client, settings):
    project = _create_project(client, name="notoptp")
    r = client.put(f"/api/v1/projects/{project['name']}/credentials", json={
        "username": "user@example.test",
        "password": "hunter2",
    })
    assert r.status_code in (200, 204), r.text
    from pathlib import Path

    content = Path(settings.credentials_file).read_text()
    prefix = f"QA_PRJ_{project['id'].upper()}"
    assert f"{prefix}_PASSWORD=hunter2" in content
    assert f"{prefix}_TOTP_SEED" not in content


def test_put_credentials_preserves_other_lines(client, settings):
    from pathlib import Path

    path = Path(settings.credentials_file)
    path.write_text("SOME_OTHER_KEY=untouched\n")

    project = _create_project(client, name="preserve")
    client.put(f"/api/v1/projects/{project['name']}/credentials", json={
        "username": "a@b.test", "password": "pw",
    })
    content = path.read_text()
    assert "SOME_OTHER_KEY=untouched" in content


def test_put_credentials_sets_role_and_serializer_status(client):
    project = _create_project(client, name="statusproj")
    client.put(f"/api/v1/projects/{project['name']}/credentials", json={
        "username": "qa@example.test", "password": "s3cret!",
    })
    full = client.get(f"/api/v1/projects/{project['name']}").json()
    assert full["credentials"] == {
        "username": "qa@example.test", "has_password": True, "has_totp": False,
    }
    user_role = next(r for r in full["roles"] if r["name"] == "user")
    prefix = f"QA_PRJ_{project['id'].upper()}"
    assert user_role["credential_ref"] == f"{prefix}_USER"
    assert full["role_matrix"] is not None  # untouched, just sanity


def test_credentials_never_leak_in_get_responses(client):
    project = _create_project(client, name="secretive")
    client.put(f"/api/v1/projects/{project['name']}/credentials", json={
        "username": "qa@example.test", "password": "s3cret!", "totp_seed": "ABCDEF",
    })
    body = client.get("/api/v1/projects").text
    assert "s3cret!" not in body
    assert "ABCDEF" not in body

    body_one = client.get(f"/api/v1/projects/{project['name']}").text
    assert "s3cret!" not in body_one
    assert "ABCDEF" not in body_one


def test_put_credentials_by_project_id(client):
    project = _create_project(client, name="byid")
    r = client.put(f"/api/v1/projects/{project['id']}/credentials", json={
        "username": "qa@example.test", "password": "s3cret!",
    })
    assert r.status_code in (200, 204), r.text


def test_put_credentials_unknown_project_404(client):
    r = client.put("/api/v1/projects/nope-does-not-exist/credentials", json={
        "username": "qa@example.test", "password": "s3cret!",
    })
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
