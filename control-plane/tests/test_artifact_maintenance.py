"""Public maintenance API tests for artifact retention and reconciliation."""

import hashlib
import json
from pathlib import Path

from conftest import create_run, finalize, ingest, result_payload


def _seed_expired_artifact(
    client,
    settings,
    *,
    terminal: bool = True,
    artifact_type: str = "console",
    filename: str = "evidence.txt",
):
    settings.retention_full_days = -1
    run_id = create_run(client)
    storage_key = f"runs/{run_id}/user-test/{filename}"
    path = Path(settings.artifacts_dir) / storage_key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"log": {"entries": []}})
        if artifact_type == "har"
        else "safe evidence"
    )
    ingest(
        client,
        run_id,
        [
            result_payload(
                "failed",
                artifacts=[
                    {
                        "type": artifact_type,
                        "storage_key": storage_key,
                        "bytes": path.stat().st_size,
                    }
                ],
            )
        ],
    )
    if terminal:
        finalize(client, run_id)
    result_id = client.get(f"/api/v1/runs/{run_id}/results").json()[0]["id"]
    return run_id, result_id, path


def test_cleanup_dry_run_then_removes_expired_artifact_consistently(client, settings):
    """Dry-run is non-destructive; real cleanup removes both file and artifact row."""
    _, result_id, path = _seed_expired_artifact(client, settings)

    dry_run = client.post(
        "/api/v1/maintenance/artifacts/cleanup", params={"dry_run": "true"}
    )
    assert dry_run.status_code == 200
    assert dry_run.json()["expired_rows"] == 1
    assert dry_run.json()["database_rows_deleted"] == 0
    assert path.is_file()
    assert len(client.get(f"/api/v1/results/{result_id}/artifacts").json()) == 1

    cleanup = client.post("/api/v1/maintenance/artifacts/cleanup")
    assert cleanup.status_code == 200
    assert cleanup.json()["database_rows_deleted"] == 1
    assert cleanup.json()["artifact_files_deleted"] == 1
    assert not path.exists()
    assert client.get(f"/api/v1/results/{result_id}/artifacts").json() == []

    status = client.get("/api/v1/maintenance/artifacts")
    assert status.status_code == 200
    assert status.json()["last_cleanup"]["database_rows_deleted"] == 1


def test_cleanup_reconciles_old_orphans_but_protects_active_run_directories(client, settings):
    """Filesystem reconciliation is deterministic and never races active workers."""
    settings.evidence_orphan_grace_seconds = 0
    active_run_id = create_run(client)
    active_orphan = Path(settings.artifacts_dir) / "runs" / active_run_id / "partial.tmp"
    active_orphan.parent.mkdir(parents=True, exist_ok=True)
    active_orphan.write_text("active")
    old_orphan = Path(settings.artifacts_dir) / "runs" / "run_orphan" / "orphan.tmp"
    old_orphan.parent.mkdir(parents=True, exist_ok=True)
    old_orphan.write_text("orphan")

    dry_run = client.post(
        "/api/v1/maintenance/artifacts/cleanup", params={"dry_run": "true"}
    ).json()
    assert dry_run["orphan_files"] == 1
    assert dry_run["orphan_files_deleted"] == 0
    assert old_orphan.is_file()
    assert active_orphan.is_file()

    cleanup = client.post("/api/v1/maintenance/artifacts/cleanup").json()
    assert cleanup["orphan_files"] == 1
    assert cleanup["orphan_files_deleted"] == 1
    assert not old_orphan.exists()
    assert active_orphan.is_file()


def test_cleanup_never_removes_evidence_for_an_active_run(client, settings):
    """Expired timestamps cannot race cleanup against a queued/running worker."""
    _, result_id, path = _seed_expired_artifact(client, settings, terminal=False)

    cleanup = client.post("/api/v1/maintenance/artifacts/cleanup")

    assert cleanup.status_code == 200
    assert cleanup.json()["active_rows_skipped"] == 1
    assert cleanup.json()["database_rows_deleted"] == 0
    assert path.is_file()
    assert len(client.get(f"/api/v1/results/{result_id}/artifacts").json()) == 1


def test_integrity_backfill_is_dry_run_safe_idempotent_and_detects_mutation(client, settings):
    """Legacy sanitized sidecars are migrated once without blessing later mutations."""
    from app.services.artifact_cleanup import backfill_artifact_integrity
    from app.services.evidence import artifact_metadata_path

    _, _, path = _seed_expired_artifact(client, settings, terminal=False)
    sidecar = artifact_metadata_path(path)
    legacy = json.loads(sidecar.read_text())
    legacy["redaction_version"] = "evidence-redaction-v1"
    legacy.pop("_sha256")
    legacy.pop("_bytes")
    sidecar.write_text(json.dumps(legacy, sort_keys=True))

    with client.app.state.SessionLocal() as session:
        dry_run = backfill_artifact_integrity(session, settings, dry_run=True)
    assert dry_run["eligible"] == 1
    assert dry_run["updated"] == 0
    assert "_sha256" not in json.loads(sidecar.read_text())

    with client.app.state.SessionLocal() as session:
        applied = backfill_artifact_integrity(session, settings)
    assert applied["eligible"] == 1
    assert applied["updated"] == 1
    migrated = json.loads(sidecar.read_text())
    content = path.read_bytes()
    assert migrated["_bytes"] == len(content)
    assert migrated["_sha256"] == hashlib.sha256(content).hexdigest()

    with client.app.state.SessionLocal() as session:
        repeat = backfill_artifact_integrity(session, settings)
    assert repeat["already_verified"] == 1
    assert repeat["updated"] == 0

    path.write_text("mutated after migration")
    with client.app.state.SessionLocal() as session:
        mismatch = backfill_artifact_integrity(session, settings)
    assert mismatch["integrity_mismatches"] == 1
    assert mismatch["updated"] == 0


def test_integrity_backfill_rejects_legacy_har_by_artifact_type(client, settings):
    """A v1 HAR cannot be blessed through a non-HAR or ambiguous DB reference."""
    from app.db import Artifact
    from app.services.artifact_cleanup import backfill_artifact_integrity
    from app.services.evidence import artifact_metadata_path

    _, _, path = _seed_expired_artifact(
        client,
        settings,
        terminal=False,
        artifact_type="har",
        filename="network.json",
    )
    sidecar = artifact_metadata_path(path)
    legacy = json.loads(sidecar.read_text())
    legacy["redaction_version"] = "evidence-redaction-v1"
    legacy.pop("_sha256")
    legacy.pop("_bytes")
    sidecar.write_text(json.dumps(legacy, sort_keys=True))

    storage_key = str(path.relative_to(Path(settings.artifacts_dir)))
    with client.app.state.SessionLocal() as session:
        existing = session.query(Artifact).filter(Artifact.storage_key == storage_key).one()
        session.add(
            Artifact(
                id=f"{existing.id}_ambiguous",
                result_id=existing.result_id,
                type="trace",
                storage_key=storage_key,
                bytes=path.stat().st_size,
            )
        )
        session.commit()

    with client.app.state.SessionLocal() as session:
        result = backfill_artifact_integrity(session, settings)

    assert result["eligible"] == 0
    assert result["updated"] == 0
    assert result["invalid_sidecars"] == 2
    persisted = json.loads(sidecar.read_text())
    assert "_sha256" not in persisted
    assert "_bytes" not in persisted
