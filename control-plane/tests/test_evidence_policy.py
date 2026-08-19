"""Public contract tests for evidence redaction and retrievability safety."""

import io
import json
import zipfile
from pathlib import Path

from conftest import create_run, ingest, result_payload, sig_input


def _write_artifact(settings, run_id: str, name: str, content: bytes = b"four") -> tuple[str, Path]:
    storage_key = f"runs/{run_id}/user-test/{name}"
    path = Path(settings.artifacts_dir) / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return storage_key, path


def test_ingest_enforces_cumulative_run_byte_quota(client, settings):
    """Separate ingestion calls share the same bounded run budget."""
    settings.evidence_max_artifact_bytes_per_run = 6
    run_id = create_run(client)
    first_key, first_path = _write_artifact(settings, run_id, "first.bin")
    ingest(
        client,
        run_id,
        [
            result_payload(
                "failed",
                artifacts=[
                    {
                        "type": "video",
                        "storage_key": first_key,
                        "bytes": first_path.stat().st_size,
                    }
                ],
            )
        ],
    )
    second_key, second_path = _write_artifact(settings, run_id, "second.bin")

    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[
            result_payload(
                "failed",
                test_name="second",
                artifacts=[
                    {
                        "type": "video",
                        "storage_key": second_key,
                        "bytes": second_path.stat().st_size,
                    }
                ],
            )
        ],
    )

    assert response.status_code == 413
    assert response.json()["title"] == "Artifact quota exceeded"
    assert len(client.get(f"/api/v1/runs/{run_id}/results").json()["items"]) == 1


def test_ingest_enters_low_disk_safety_mode_before_artifact_processing(client, settings):
    """The installation reserve disables artifact ingestion before disk exhaustion."""
    settings.evidence_min_free_disk_bytes = 10**30
    run_id = create_run(client)
    storage_key, path = _write_artifact(settings, run_id, "evidence.bin")

    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[
            result_payload(
                "failed",
                artifacts=[
                    {
                        "type": "video",
                        "storage_key": storage_key,
                        "bytes": path.stat().st_size,
                    }
                ],
            )
        ],
    )

    assert response.status_code == 507
    assert response.json()["title"] == "Evidence storage unavailable"
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_ingest_rejects_artifact_count_over_result_quota(client, settings):
    """Quota exhaustion is explicit and persists neither result nor artifact rows."""
    settings.evidence_max_artifacts_per_result = 1
    run_id = create_run(client)
    artifacts = []
    for name in ("first.txt", "second.txt"):
        storage_key = f"runs/{run_id}/user-test/{name}"
        path = Path(settings.artifacts_dir) / storage_key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("safe")
        artifacts.append(
            {"type": "console", "storage_key": storage_key, "bytes": path.stat().st_size}
        )

    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("failed", artifacts=artifacts)],
    )

    assert response.status_code == 413
    assert response.json()["title"] == "Artifact quota exceeded"
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_ingest_uses_actual_file_size_for_result_byte_quota(client, settings):
    """Workers cannot bypass byte quotas by understating artifact metadata."""
    settings.evidence_max_artifact_bytes_per_result = 5
    run_id = create_run(client)
    storage_key = f"runs/{run_id}/user-test/evidence.txt"
    path = Path(settings.artifacts_dir) / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("sixsix")

    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[
            result_payload(
                "failed",
                artifacts=[
                    {"type": "console", "storage_key": storage_key, "bytes": 1}
                ],
            )
        ],
    )

    assert response.status_code == 413
    assert response.json()["title"] == "Artifact quota exceeded"
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_ingest_rewrites_trace_zip_before_signed_download(client, settings):
    """Text and opaque trace members cannot expose configured credential literals."""
    Path(settings.credentials_file).write_text("QA_CRED_USER_PASSWORD=trace-secret\n")
    run_id = create_run(client)
    storage_key = f"runs/{run_id}/user-test/trace.zip"
    path = Path(settings.artifacts_dir) / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "trace.trace",
            '{"authorization":"Bearer trace-secret","safe":"visible"}',
        )
        archive.writestr("resources/opaque.bin", b"prefix\x00trace-secret\x00suffix")

    ingest(
        client,
        run_id,
        [
            result_payload(
                "failed",
                artifacts=[
                    {
                        "type": "trace",
                        "storage_key": storage_key,
                        "bytes": path.stat().st_size,
                    }
                ],
            )
        ],
    )
    result_id = client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0]["id"]
    descriptor = client.get(f"/api/v1/results/{result_id}/artifacts").json()[0]
    downloaded = client.get(descriptor["url"])

    assert downloaded.status_code == 200
    assert descriptor["metadata"]["redaction_version"] == "evidence-redaction-v2"
    with zipfile.ZipFile(io.BytesIO(downloaded.content)) as archive:
        members = {name: archive.read(name) for name in archive.namelist()}
    assert b"trace-secret" not in b"".join(members.values())
    assert b"[REDACTED]" in members["trace.trace"]
    assert b"[REDACTED]" in members["resources/opaque.bin"]


def test_ingest_redacts_structured_and_har_evidence_before_retrieval(client, settings):
    """Fixture secrets and sensitive fields never survive into retrievable evidence."""
    fixture_password = "fixture-super-" + "secret"
    Path(settings.credentials_file).write_text(
        f"QA_CRED_USER_PASSWORD={fixture_password}\n"
        "QA_CRED_USER_EMAIL=fixture-user@example.test\n"
    )
    from app.services.evidence import evidence_policy

    policy = evidence_policy(settings)
    assert fixture_password in policy.literal_secrets
    assert "fixture-user@example.test" in policy.literal_secrets
    run_id = create_run(client)
    storage_key = f"runs/{run_id}/user-test/network.har"
    artifact_path = Path(settings.artifacts_dir) / storage_key
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(
        json.dumps(
            {
                "log": {
                    "entries": [
                        {
                            "request": {
                                "url": "https://app.example.test/api?token=query-secret&safe=yes#private",
                                "queryString": [
                                    {"name": "token", "value": "structured-query-secret"},
                                    {"name": "safe", "value": "visible-query-value"},
                                ],
                                "headers": [
                                    {"name": "Authorization", "value": "Bearer bearer-secret"},
                                    {"name": "Cookie", "value": "sid=session-secret"},
                                ],
                                "cookies": [
                                    {
                                        "name": "sessionId",
                                        "value": "structured-request-cookie-secret",
                                        "domain": "app.example.test",
                                        "path": "/",
                                        "httpOnly": True,
                                        "secure": True,
                                    }
                                ],
                                "postData": {
                                    "mimeType": "application/json",
                                    "params": [
                                        {"name": "password", "value": "structured-form-secret"},
                                        {"name": "safe", "value": "visible-form-value"},
                                    ],
                                    "text": json.dumps(
                                        {
                                            "password": "fixture-super-secret",
                                            "safe": "visible",
                                        }
                                    ),
                                },
                            },
                            "response": {
                                "headers": [
                                    {"name": "Set-Cookie", "value": "sid=response-secret"}
                                ],
                                "cookies": [
                                    {
                                        "name": "app-session",
                                        "value": "structured-response-cookie-secret",
                                        "domain": ".example.test",
                                        "path": "/",
                                        "httpOnly": True,
                                        "secure": True,
                                        "sameSite": "Strict",
                                    }
                                ],
                                "content": {
                                    "mimeType": "application/json",
                                    "text": json.dumps(
                                        {
                                            "accessToken": "response-token",
                                            "ownerEmail": "fixture-user@example.test",
                                            "safe": "visible",
                                        }
                                    ),
                                },
                            },
                        },
                        {
                            "request": {
                                "cookies": {
                                    "name": "sessionId",
                                    "value": "malformed-cookie-object-secret",
                                    "domain": "app.example.test",
                                    "unexpected": "malformed-cookie-arbitrary-secret",
                                    "nested": {
                                        "unexpected": "nested-malformed-cookie-secret"
                                    },
                                }
                            },
                            "response": {"cookies": ["malformed-cookie-scalar-secret"]},
                        },
                        {
                            "request": {
                                "cookies": {"sessionId": "malformed-cookie-map-secret"}
                            },
                            "response": {},
                        },
                    ]
                }
            }
        )
    )

    ingest(
        client,
        run_id,
        [
            result_payload(
                "failed",
                signature_input=sig_input(error="Bearer signature-secret"),
                failed_action={
                    "step": "login",
                    "error": "fixture-super-secret",
                    "actual": "token=query-secret",
                },
                console_summary=[
                    {
                        "level": "error",
                        "kind": "console",
                        "text": "Authorization: Bearer bearer-secret fixture-super-secret",
                        "source": None,
                        "raw_source": "https://app.example.test/a.js?session=url-secret#fragment",
                        "count": 1,
                    }
                ],
                network_summary=[
                    {
                        "method": "GET",
                        "url_path": "/api?token=query-secret&safe=yes#fragment",
                        "status": 500,
                        "timing_ms": 10,
                        "resp_snippet": '{"password":"fixture-super-secret","safe":"visible"}',
                    }
                ],
                artifacts=[
                    {
                        "type": "har",
                        "storage_key": storage_key,
                        "bytes": artifact_path.stat().st_size,
                    }
                ],
            )
        ],
    )

    result = client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0]
    serialized = json.dumps(result)
    assert "fixture-super-secret" not in serialized
    assert "bearer-secret" not in serialized
    assert "query-secret" not in serialized
    assert "[REDACTED]" in serialized

    artifact = client.get(f"/api/v1/results/{result['id']}/har", params={"failures_only": "false"})
    assert artifact.status_code == 200
    descriptor = artifact.json()
    assert descriptor["metadata"]["redaction_version"] == "evidence-redaction-v2"
    downloaded = client.get(descriptor["url"])
    assert downloaded.status_code == 200
    body = downloaded.text
    for secret in (
        "fixture-super-secret",
        "fixture-user@example.test",
        "bearer-secret",
        "session-secret",
        "response-secret",
        "structured-request-cookie-secret",
        "structured-response-cookie-secret",
        "structured-query-secret",
        "structured-form-secret",
        "malformed-cookie-object-secret",
        "malformed-cookie-scalar-secret",
        "malformed-cookie-arbitrary-secret",
        "nested-malformed-cookie-secret",
        "malformed-cookie-map-secret",
        "response-token",
        "query-secret",
        "url-secret",
        "fragment",
    ):
        assert secret not in body
    assert "visible" in body
    assert "[REDACTED]" in body
    redacted_har = downloaded.json()
    request_cookie = redacted_har["log"]["entries"][0]["request"]["cookies"][0]
    response_cookie = redacted_har["log"]["entries"][0]["response"]["cookies"][0]
    query_params = redacted_har["log"]["entries"][0]["request"]["queryString"]
    form_params = redacted_har["log"]["entries"][0]["request"]["postData"]["params"]
    assert request_cookie == {
        "name": "sessionId",
        "value": "[REDACTED]",
        "domain": "app.example.test",
        "path": "/",
        "httpOnly": True,
        "secure": True,
    }
    assert response_cookie == {
        "name": "app-session",
        "value": "[REDACTED]",
        "domain": ".example.test",
        "path": "/",
        "httpOnly": True,
        "secure": True,
        "sameSite": "Strict",
    }
    assert query_params == [
        {"name": "token", "value": "[REDACTED]"},
        {"name": "safe", "value": "visible-query-value"},
    ]
    assert form_params == [
        {"name": "password", "value": "[REDACTED]"},
        {"name": "safe", "value": "visible-form-value"},
    ]
    malformed_entry = redacted_har["log"]["entries"][1]
    assert malformed_entry["request"]["cookies"] == {
        "name": "sessionId",
        "value": "[REDACTED]",
        "domain": "app.example.test",
        "unexpected": "[REDACTED]",
        "nested": {"unexpected": "[REDACTED]"},
    }
    assert malformed_entry["response"]["cookies"] == ["[REDACTED]"]
    assert redacted_har["log"]["entries"][2]["request"]["cookies"] == {
        "sessionId": "[REDACTED]"
    }


def test_ingest_rejects_non_zip_trace(client, settings):
    run_id = create_run(client)
    storage_key, _ = _write_artifact(settings, run_id, "trace.zip", b"not-a-zip-secret")
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("failed", artifacts=[{
            "type": "trace", "storage_key": storage_key,
        }])],
    )
    assert response.status_code == 400
    assert response.json()["title"] == "Invalid artifact"
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_ingest_rejects_unknown_artifact_type(client, settings):
    run_id = create_run(client)
    storage_key, _ = _write_artifact(settings, run_id, "unknown.bin")
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("failed", artifacts=[{
            "type": "raw_secret_dump", "storage_key": storage_key,
        }])],
    )
    assert response.status_code == 422
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_ingest_rejects_symlink_escape(client, settings, tmp_path):
    run_id = create_run(client)
    outside = tmp_path / "outside.txt"
    outside.write_text("secret")
    link = Path(settings.artifacts_dir) / "runs" / run_id / "case" / "escape.txt"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(outside)
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("failed", artifacts=[{
            "type": "console",
            "storage_key": str(link.relative_to(settings.artifacts_dir)),
        }])],
    )
    assert response.status_code == 400
    assert response.json()["title"] == "Invalid artifact key"
    assert outside.read_text() == "secret"


def test_artifact_metadata_declares_no_raw_variant(client, settings):
    run_id = create_run(client)
    storage_key, _ = _write_artifact(settings, run_id, "console.jsonl", b'{"message":"safe"}\n')
    ingest(client, run_id, [result_payload("passed", artifacts=[{
        "type": "console", "storage_key": storage_key,
    }])])
    result_id = client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0]["id"]
    artifact = client.get(f"/api/v1/results/{result_id}/artifacts").json()[0]
    assert artifact["metadata"] == {
        "redaction_version": "evidence-redaction-v2",
        "state": "redacted",
        "raw_variant_retrievable": False,
    }
