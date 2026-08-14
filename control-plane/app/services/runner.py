"""Spawn the browser-worker runner as a detached subprocess (runner_mode="subprocess")."""
import json
import logging
import os
import subprocess
from pathlib import Path

from app.db import TestRun
from app.settings import Settings

logger = logging.getLogger(__name__)

# control-plane/app/services/runner.py -> repo root is parents[3]
_REPO_ROOT = Path(__file__).resolve().parents[3]
_BROWSER_WORKER_DIR = _REPO_ROOT / "browser-worker"


def maybe_spawn(run: TestRun, settings: Settings) -> None:
    """Best-effort spawn of the worker runner. Never raises - failures are logged only."""
    if settings.runner_mode != "subprocess":
        return
    try:
        _spawn(run, settings)
    except Exception:
        logger.exception("failed to spawn browser-worker runner for run_id=%s", run.id)


def _spawn(run: TestRun, settings: Settings) -> None:
    port = os.environ.get("QA_CP_PORT", "8787")
    env = os.environ.copy()
    env.update(
        {
            "QA_RUN_ID": run.id,
            "QA_RUN_BASE_URL": run.base_url,
            "QA_RUN_ROUTES": json.dumps(run.requested_routes or []),
            "QA_RUN_ROLES": json.dumps(run.requested_roles or []),
            "QA_CP_URL": f"http://127.0.0.1:{port}/api/v1",
            "QA_API_TOKEN": settings.api_token,
            "QA_ARTIFACTS_DIR": str(Path(settings.artifacts_dir).resolve()),
        }
    )
    log_dir = _REPO_ROOT / "var" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = open(log_dir / f"runner-{run.id}.log", "ab")
    subprocess.Popen(
        ["npx", "tsx", "src/runner.ts"],
        cwd=str(_BROWSER_WORKER_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
