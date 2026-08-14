"""Failure clustering: signature hashing, severity rules, bundle assembly."""
import hashlib
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.db import Artifact, FailureCluster, Project, TestResult, TestRun
from app.ids import new_id
from app.services.signing import signed_url_for
from app.settings import Settings

SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2}


def compute_severity(result: TestResult) -> str:
    network = result.network_summary or []
    console = result.console_summary or []

    if any((row.get("status") or 0) >= 500 for row in network):
        return "high"
    if any(row.get("kind") == "pageerror" for row in console):
        return "high"

    if result.shell_rendered is True and result.failed_action:
        return "medium"

    if console and not network and all(row.get("level") == "warning" for row in console):
        return "low"

    return "medium"


def signature_hash(signature_input: dict, result: TestResult) -> str:
    error = signature_input.get("normalized_error", "") or ""
    frame = signature_input.get("top_stack_frame", "") or ""
    # suite (non-matrix) results legitimately have no route — never join None
    route = signature_input.get("route") or result.route_path or ""
    role = signature_input.get("role") or result.role or ""
    raw = "|".join([error, frame, route, role])
    return hashlib.sha256(raw.encode()).hexdigest()


def _to_unix(dt: datetime | None) -> int | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def cluster_run(session: Session, run: TestRun, settings: Settings) -> int:
    """Cluster failed, non-flaky results with signature_input into failure bundles.

    Replaces any existing clusters for this run (finalize is expected to run once,
    but this keeps re-finalization idempotent). Returns the number of bundles created.
    """
    session.query(FailureCluster).filter_by(run_id=run.id).delete()

    project = session.get(Project, run.project_id) if run.project_id else None
    project_name = project.name if project else None

    results = (
        session.query(TestResult)
        .filter_by(run_id=run.id, status="failed", flaky=False)
        .all()
    )

    groups: dict[str, list[TestResult]] = {}
    for result in results:
        if not result.signature_input:
            continue
        h = signature_hash(result.signature_input, result)
        groups.setdefault(h, []).append(result)

    created = 0
    for sig_hash, members in groups.items():
        scored = [(compute_severity(m), m) for m in members]
        scored.sort(key=lambda item: (-SEVERITY_RANK[item[0]], item[1].duration_ms or 0))
        cluster_severity, exemplar = scored[0]

        affected: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for m in members:
            sig_in = m.signature_input or {}
            route = sig_in.get("route") or m.route_path
            role = sig_in.get("role") or m.role
            key = (route, role)
            if key not in seen:
                seen.add(key)
                affected.append({"route": route, "role": role})

        cluster_id = new_id("cl")
        bundle_id = new_id("fb")

        exemplar_artifacts = session.query(Artifact).filter_by(result_id=exemplar.id).all()
        artifact_urls: dict[str, str] = {}
        expiry_candidates: list[datetime] = []
        for art in exemplar_artifacts:
            exp_unix = _to_unix(art.expires_at)
            artifact_urls[art.type] = signed_url_for(settings, art.storage_key, expires_at=exp_unix)
            if art.expires_at is not None:
                expiry_candidates.append(art.expires_at)

        if expiry_candidates:
            artifact_expiry = min(expiry_candidates)
        else:
            artifact_expiry = datetime.now(timezone.utc) + timedelta(days=7)

        bundle = {
            "bundle_id": bundle_id,
            "run_id": run.id,
            "cluster_id": cluster_id,
            "occurrences": len(members),
            "severity": cluster_severity,
            "affected": affected,
            "test": {
                "name": exemplar.test_name,
                "file": exemplar.test_file,
                "status": exemplar.status,
                "duration_ms": exemplar.duration_ms,
                "flaky": exemplar.flaky,
                "reruns_attempted": exemplar.reruns_attempted,
                "reruns_failed": exemplar.reruns_failed,
            },
            "failed_action": exemplar.failed_action,
            "console_errors": exemplar.console_summary,
            "network_failures": exemplar.network_summary,
            "dom_excerpt": exemplar.dom_excerpt,
            "app": {"project": project_name, "base_url": run.base_url, "version": run.app_version},
            "artifacts": artifact_urls,
            "artifact_expiry": artifact_expiry.isoformat(),
        }

        session.add(
            FailureCluster(
                id=cluster_id,
                run_id=run.id,
                signature_hash=sig_hash,
                severity=cluster_severity,
                occurrences=len(members),
                exemplar_result_id=exemplar.id,
                affected=affected,
                bundle=bundle,
                created_at=datetime.now(timezone.utc),
            )
        )
        created += 1

    return created
