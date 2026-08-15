"""Idempotent artifact retention, usage reporting, and orphan reconciliation."""

import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import Artifact, TestResult, TestRun, make_engine_and_sessionmaker
from app.services.evidence import artifact_metadata_path
from app.settings import Settings

_ACTIVE_STATUSES = frozenset({"queued", "running"})


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def artifact_usage(session: Session, settings: Settings) -> dict[str, int]:
    """Return bounded aggregate storage metrics without exposing filenames."""
    root = Path(settings.artifacts_dir)
    root.mkdir(parents=True, exist_ok=True)
    database_bytes = int(
        session.query(func.coalesce(func.sum(Artifact.bytes), 0)).scalar() or 0
    )
    database_artifacts = int(session.query(Artifact).count())
    filesystem_files = 0
    filesystem_bytes = 0
    for path in root.rglob("*"):
        if path.is_file():
            filesystem_files += 1
            try:
                filesystem_bytes += path.stat().st_size
            except FileNotFoundError:
                continue
    disk = shutil.disk_usage(root)
    return {
        "database_artifacts": database_artifacts,
        "database_bytes": database_bytes,
        "filesystem_files": filesystem_files,
        "filesystem_bytes": filesystem_bytes,
        "disk_free_bytes": disk.free,
        "disk_total_bytes": disk.total,
    }


def backfill_artifact_integrity(
    session: Session,
    settings: Settings,
    *,
    dry_run: bool = False,
) -> dict[str, int | bool]:
    """Add immutable-byte fields to trusted legacy redaction sidecars.

    Only database-referenced, path-safe, non-symlink files with the exact legacy
    sanitized-state contract are eligible. Existing integrity fields are verified
    and never overwritten on mismatch.
    """
    root = Path(settings.artifacts_dir).resolve()
    summary: dict[str, int | bool] = {
        "dry_run": dry_run,
        "database_artifacts": 0,
        "already_verified": 0,
        "eligible": 0,
        "updated": 0,
        "unsafe_paths": 0,
        "missing_files": 0,
        "invalid_sidecars": 0,
        "integrity_mismatches": 0,
        "errors": 0,
    }
    for artifact in session.query(Artifact).all():
        summary["database_artifacts"] += 1
        lexical_target = root / artifact.storage_key
        target = lexical_target.resolve()
        try:
            target.relative_to(root)
        except ValueError:
            summary["unsafe_paths"] += 1
            continue
        if lexical_target.is_symlink() or not target.is_file():
            summary["missing_files" if not target.is_file() else "unsafe_paths"] += 1
            continue
        sidecar = artifact_metadata_path(target)
        if sidecar.is_symlink() or not sidecar.is_file():
            summary["invalid_sidecars"] += 1
            continue
        try:
            metadata = json.loads(sidecar.read_text())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            summary["invalid_sidecars"] += 1
            continue
        if not isinstance(metadata, dict) or any(
            (
                metadata.get("redaction_version") != "evidence-redaction-v1",
                metadata.get("state") != "redacted",
                metadata.get("raw_variant_retrievable") is not False,
            )
        ):
            summary["invalid_sidecars"] += 1
            continue
        try:
            content = target.read_bytes()
        except OSError:
            summary["errors"] += 1
            continue
        digest = hashlib.sha256(content).hexdigest()
        byte_count = len(content)
        if "_sha256" in metadata or "_bytes" in metadata:
            if metadata.get("_sha256") == digest and metadata.get("_bytes") == byte_count:
                summary["already_verified"] += 1
            else:
                summary["integrity_mismatches"] += 1
            continue
        summary["eligible"] += 1
        if dry_run:
            continue
        metadata["_sha256"] = digest
        metadata["_bytes"] = byte_count
        temporary = sidecar.with_name(f".{sidecar.name}.integrity.tmp")
        try:
            temporary.write_text(json.dumps(metadata, sort_keys=True))
            temporary.replace(sidecar)
            summary["updated"] += 1
        except OSError:
            summary["errors"] += 1
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
    return summary


def cleanup_artifacts(
    session: Session,
    settings: Settings,
    *,
    dry_run: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Remove expired/missing artifact rows and old orphan files, safely and idempotently."""
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    root = Path(settings.artifacts_dir).resolve()
    root.mkdir(parents=True, exist_ok=True)

    summary: dict[str, Any] = {
        "dry_run": dry_run,
        "expired_rows": 0,
        "missing_file_rows": 0,
        "active_rows_skipped": 0,
        "database_rows_deleted": 0,
        "artifact_files_deleted": 0,
        "metadata_files_deleted": 0,
        "orphan_files": 0,
        "orphan_files_deleted": 0,
        "errors": 0,
    }

    rows = (
        session.query(Artifact, TestResult, TestRun)
        .join(TestResult, Artifact.result_id == TestResult.id)
        .join(TestRun, TestResult.run_id == TestRun.id)
        .all()
    )
    referenced_paths: set[Path] = set()
    active_run_roots: set[Path] = {
        (root / "runs" / run_id).resolve()
        for (run_id,) in session.query(TestRun.id)
        .filter(TestRun.status.in_(_ACTIVE_STATUSES))
        .all()
    }

    for artifact, _, run in rows:
        target = (root / artifact.storage_key).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            target = root / "__invalid_artifact_key__"
        metadata_path = artifact_metadata_path(target)
        referenced_paths.update({target, metadata_path})
        if run.status in _ACTIVE_STATUSES:
            active_run_roots.add((root / "runs" / run.id).resolve())

        expired = (_as_utc(artifact.expires_at) or current) <= current
        missing = not target.is_file()
        if expired:
            summary["expired_rows"] += 1
        if missing:
            summary["missing_file_rows"] += 1
        if not expired and not missing:
            continue
        if run.status in _ACTIVE_STATUSES:
            summary["active_rows_skipped"] += 1
            continue
        if dry_run:
            continue

        if target.is_file():
            try:
                target.unlink()
                summary["artifact_files_deleted"] += 1
            except OSError:
                summary["errors"] += 1
                continue
        if metadata_path.is_file():
            try:
                metadata_path.unlink()
                summary["metadata_files_deleted"] += 1
            except OSError:
                summary["errors"] += 1
        session.delete(artifact)
        summary["database_rows_deleted"] += 1

    grace_seconds = settings.evidence_orphan_grace_seconds
    for path in root.rglob("*"):
        if not path.is_file() or path in referenced_paths:
            continue
        if any(_is_beneath(path, active_root) for active_root in active_run_roots):
            continue
        try:
            age_seconds = current.timestamp() - path.stat().st_mtime
        except FileNotFoundError:
            continue
        if age_seconds < grace_seconds:
            continue
        summary["orphan_files"] += 1
        if not dry_run:
            try:
                path.unlink()
                summary["orphan_files_deleted"] += 1
            except OSError:
                summary["errors"] += 1

    if not dry_run:
        session.commit()
        _remove_empty_directories(root)
    return summary


def _is_beneath(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _remove_empty_directories(root: Path) -> None:
    directories = sorted(
        (path for path in root.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    )
    for directory in directories:
        try:
            directory.rmdir()
        except OSError:
            continue


def main() -> None:
    """CLI entry point reusable by cron, systemd, and operator automation."""
    parser = argparse.ArgumentParser(description="Reconcile Auto QA artifact storage")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--backfill-integrity",
        action="store_true",
        help="add immutable hashes/byte counts to trusted legacy redaction sidecars",
    )
    args = parser.parse_args()
    settings = Settings()
    _, session_local = make_engine_and_sessionmaker(settings.database_url)
    with session_local() as session:
        if args.backfill_integrity:
            summary = backfill_artifact_integrity(session, settings, dry_run=args.dry_run)
        else:
            summary = cleanup_artifacts(session, settings, dry_run=args.dry_run)
    print(json.dumps(summary, sort_keys=True))


if __name__ == "__main__":
    main()
