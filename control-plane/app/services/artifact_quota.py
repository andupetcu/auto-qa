"""Installation, project, run, and result artifact quota enforcement."""

import shutil
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db import Artifact, TestResult, TestRun
from app.problems import ProblemException
from app.settings import Settings


def _artifact_bytes_for_run(session: Session, run_id: str) -> int:
    value = (
        session.query(func.coalesce(func.sum(Artifact.bytes), 0))
        .join(TestResult, Artifact.result_id == TestResult.id)
        .filter(TestResult.run_id == run_id)
        .scalar()
    )
    return int(value or 0)


def _artifact_bytes_for_project(session: Session, project_id: str | None) -> int:
    if project_id is None:
        return 0
    value = (
        session.query(func.coalesce(func.sum(Artifact.bytes), 0))
        .join(TestResult, Artifact.result_id == TestResult.id)
        .join(TestRun, TestResult.run_id == TestRun.id)
        .filter(TestRun.project_id == project_id)
        .scalar()
    )
    return int(value or 0)


def require_evidence_disk_capacity(settings: Settings) -> None:
    """Fail before artifact persistence when reserved free space is exhausted."""
    artifact_dir = Path(settings.artifacts_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True)
    free_bytes = shutil.disk_usage(artifact_dir).free
    if free_bytes < settings.evidence_min_free_disk_bytes:
        raise ProblemException(
            507,
            "Evidence storage unavailable",
            "Artifact capture is disabled because free disk space is below the safety reserve",
        )


@dataclass
class ArtifactQuotaTracker:
    """Tracks atomic quota reservations across one result-ingestion request."""

    settings: Settings
    run_bytes: int
    project_bytes: int

    @classmethod
    def for_run(
        cls, session: Session, settings: Settings, run: TestRun
    ) -> "ArtifactQuotaTracker":
        return cls(
            settings=settings,
            run_bytes=_artifact_bytes_for_run(session, run.id),
            project_bytes=_artifact_bytes_for_project(session, run.project_id),
        )

    def reserve_result(self, artifact_count: int, artifact_bytes: int) -> None:
        """Reserve one result's artifacts or raise a clear quota problem."""
        if artifact_count > self.settings.evidence_max_artifacts_per_result:
            raise ProblemException(
                413,
                "Artifact quota exceeded",
                "Result contains more artifacts than the configured limit",
            )
        if artifact_bytes > self.settings.evidence_max_artifact_bytes_per_result:
            raise ProblemException(
                413,
                "Artifact quota exceeded",
                "Result artifact bytes exceed the configured limit",
            )
        if self.run_bytes + artifact_bytes > self.settings.evidence_max_artifact_bytes_per_run:
            raise ProblemException(
                413,
                "Artifact quota exceeded",
                "Run artifact bytes exceed the configured limit",
            )
        if self.project_bytes + artifact_bytes > self.settings.evidence_project_quota_bytes:
            raise ProblemException(
                413,
                "Artifact quota exceeded",
                "Project artifact storage quota is exhausted",
            )
        self.run_bytes += artifact_bytes
        self.project_bytes += artifact_bytes
