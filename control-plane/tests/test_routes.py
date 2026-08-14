def test_config_routes_discovered_on_startup(client):
    r = client.get("/api/v1/routes")
    assert r.status_code == 200
    routes = r.json()
    paths = {x["path"] for x in routes}
    assert paths == {"/", "/campaigns/campaign-library", "/campaigns/reports"}
    for x in routes:
        assert x["id"].startswith("rt_")
        assert x["discovery_source"] == "config"
        assert x["base_url"] == "https://app.example.test"


def test_discover_config_merge_is_idempotent(client):
    r1 = client.post("/api/v1/routes/discover", json={"mode": "config"})
    assert r1.status_code == 200
    r2 = client.get("/api/v1/routes")
    assert len(r2.json()) == 3  # merge never duplicates
