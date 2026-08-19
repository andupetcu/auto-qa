"""Public visual-evidence projection and manifest integrity contracts."""

import hashlib
import json
from pathlib import Path

from conftest import create_run, ingest, result_payload


def _descriptor(filename: str, content: bytes) -> dict:
    return {
        "filename": filename,
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
        "width": 120,
        "height": 80,
    }


def test_visual_evidence_projection_is_ordered_signed_and_result_bound(client, settings):
    run_id = create_run(client)
    root = Path(settings.artifacts_dir) / "runs" / run_id / "user-visual"
    root.mkdir(parents=True, exist_ok=True)
    screenshot = b"safe-masked-screenshot"
    sheet = b"safe-contact-sheet"
    screenshot_path = root / "final-screenshot.png"
    sheet_path = root / "contact-sheet.webp"
    screenshot_path.write_bytes(screenshot)
    sheet_path.write_bytes(sheet)
    manifest = {
        "schemaVersion": 1,
        "resultId": None,
        "resultKey": "user-visual",
        "route": "/campaigns/reports",
        "role": "user",
        "browser": "chromium",
        "viewport": "1440x900",
        "capturePolicyVersion": 1,
        "frames": [
            {
                "index": 0,
                "milestone": "navigation",
                "capturedAt": "2026-08-15T08:00:00.000Z",
                **_descriptor("frame-00-navigation.png", b"not-retained"),
            },
            {
                "index": 1,
                "milestone": "asserted",
                "capturedAt": "2026-08-15T08:00:01.000Z",
                **_descriptor("frame-01-asserted.png", b"not-retained-2"),
            },
        ],
        "finalScreenshot": _descriptor(screenshot_path.name, screenshot),
        "contactSheet": _descriptor(sheet_path.name, sheet),
        "warnings": [],
    }
    manifest_path = root / "visual-manifest.json"
    manifest_path.write_text(json.dumps(manifest))

    ingest(
        client,
        run_id,
        [
            result_payload(
                "failed",
                artifacts=[
                    {
                        "type": "screenshot",
                        "storage_key": str(screenshot_path.relative_to(settings.artifacts_dir)),
                        "bytes": 1,
                    },
                    {
                        "type": "contact_sheet",
                        "storage_key": str(sheet_path.relative_to(settings.artifacts_dir)),
                        "bytes": 1,
                    },
                    {
                        "type": "visual_manifest",
                        "storage_key": str(manifest_path.relative_to(settings.artifacts_dir)),
                        "bytes": 1,
                    },
                ],
            )
        ],
    )
    result_id = client.get(f"/api/v1/runs/{run_id}/results").json()["items"][0]["id"]

    response = client.get(f"/api/v1/results/{result_id}/visual-evidence")
    assert response.status_code == 200
    visual = response.json()
    assert visual["status"] == "captured"
    assert visual["manifest"]["resultId"] == result_id
    assert [frame["index"] for frame in visual["frames"]] == [0, 1]
    assert all(frame["artifact"] is None for frame in visual["frames"])
    assert visual["finalScreenshot"]["artifact"]["url"].startswith("/artifacts/")
    assert visual["contactSheet"]["artifact"]["url"].startswith("/artifacts/")

    manifest_artifact = next(
        artifact
        for artifact in client.get(f"/api/v1/results/{result_id}/artifacts").json()
        if artifact["type"] == "visual_manifest"
    )
    downloaded = client.get(manifest_artifact["url"])
    assert downloaded.status_code == 200
    assert downloaded.json()["resultId"] == result_id


def test_visual_manifest_hash_mismatch_is_rejected_before_persistence(client, settings):
    run_id = create_run(client)
    root = Path(settings.artifacts_dir) / "runs" / run_id / "user-bad-visual"
    root.mkdir(parents=True, exist_ok=True)
    screenshot_path = root / "final-screenshot.png"
    screenshot_path.write_bytes(b"actual")
    manifest_path = root / "visual-manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "resultId": None,
                "frames": [],
                "finalScreenshot": _descriptor(screenshot_path.name, b"different"),
                "contactSheet": None,
                "warnings": [],
            }
        )
    )

    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[
            result_payload(
                "failed",
                artifacts=[
                    {
                        "type": "screenshot",
                        "storage_key": str(screenshot_path.relative_to(settings.artifacts_dir)),
                        "bytes": 1,
                    },
                    {
                        "type": "visual_manifest",
                        "storage_key": str(manifest_path.relative_to(settings.artifacts_dir)),
                        "bytes": 1,
                    },
                ],
            )
        ],
    )
    assert response.status_code == 400
    assert response.json()["title"] == "Visual evidence integrity failure"
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_visual_artifacts_without_manifest_are_rejected(client, settings):
    run_id = create_run(client)
    path = Path(settings.artifacts_dir) / "runs" / run_id / "case" / "final.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"masked")
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("passed", artifacts=[{
            "type": "screenshot",
            "storage_key": str(path.relative_to(settings.artifacts_dir)),
        }])],
    )
    assert response.status_code == 400
    assert response.json()["title"] == "Visual evidence integrity failure"
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_manifest_rejects_unreferenced_extra_screenshot(client, settings):
    run_id = create_run(client)
    root = Path(settings.artifacts_dir) / "runs" / run_id / "case"
    root.mkdir(parents=True, exist_ok=True)
    first = root / "first.png"
    second = root / "second.png"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps({
        "schemaVersion": 1,
        "resultId": None,
        "frames": [],
        "finalScreenshot": _descriptor(first.name, first.read_bytes()),
        "contactSheet": None,
        "warnings": [],
    }))
    artifacts = [
        {"type": "screenshot", "storage_key": str(path.relative_to(settings.artifacts_dir))}
        for path in (first, second)
    ] + [{"type": "visual_manifest", "storage_key": str(manifest_path.relative_to(settings.artifacts_dir))}]
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("passed", artifacts=artifacts)],
    )
    assert response.status_code == 400
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_manifest_rejects_visual_artifact_from_another_result_directory(client, settings):
    run_id = create_run(client)
    root = Path(settings.artifacts_dir) / "runs" / run_id
    screenshot = root / "foreign" / "final.png"
    manifest_path = root / "owner" / "manifest.json"
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    screenshot.write_bytes(b"masked")
    manifest_path.write_text(json.dumps({
        "schemaVersion": 1,
        "resultId": None,
        "frames": [],
        "finalScreenshot": _descriptor(screenshot.name, screenshot.read_bytes()),
        "contactSheet": None,
        "warnings": [],
    }))
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("passed", artifacts=[
            {"type": "screenshot", "storage_key": str(screenshot.relative_to(settings.artifacts_dir))},
            {"type": "visual_manifest", "storage_key": str(manifest_path.relative_to(settings.artifacts_dir))},
        ])],
    )
    assert response.status_code == 400
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []


def test_manifest_rejects_duplicate_retained_frame_reference(client, settings):
    run_id = create_run(client)
    root = Path(settings.artifacts_dir) / "runs" / run_id / "case"
    root.mkdir(parents=True, exist_ok=True)
    frame = root / "frame.png"
    frame.write_bytes(b"frame")
    descriptor = {"index": 0, "milestone": "navigation", "capturedAt": "now", **_descriptor(frame.name, frame.read_bytes())}
    manifest_path = root / "manifest.json"
    manifest_path.write_text(json.dumps({
        "schemaVersion": 1,
        "resultId": None,
        "frames": [descriptor, {**descriptor, "index": 1}],
        "finalScreenshot": None,
        "contactSheet": None,
        "warnings": [],
    }))
    response = client.post(
        f"/api/v1/internal/runs/{run_id}/results",
        json=[result_payload("passed", artifacts=[
            {"type": "screenshot_frame", "storage_key": str(frame.relative_to(settings.artifacts_dir))},
            {"type": "visual_manifest", "storage_key": str(manifest_path.relative_to(settings.artifacts_dir))},
        ])],
    )
    assert response.status_code == 400
    assert client.get(f"/api/v1/runs/{run_id}/results").json()["items"] == []
