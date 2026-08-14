"""Spawn the browser-worker runner as a detached subprocess (runner_mode="subprocess")."""
import json
import logging
import os
import subprocess
from pathlib import Path

from app.db import TestRun
from app.settings import Settings

logger = logging.getLogger(__name__)

_BROWSER_WORKER_DIR = Path(__file__).resolve().parents[2] / "browser-worker"


def maybe_spawn(run: TestRun, settings: Settings) -> None:
    """Best-effort spawn of the worker runner. Never raises - failures are logged only."""
    if settings.runner_mode != "subprocess":
        return
    try:
        _spawn(run, settings)
    except Exception:
        logger.exception("failed to spawn browser-worker runner for run_id=%s", run.id)


def _spawn(run: TestRun, settings: Settings) -> None:
    port = os.environ.get("QA_PORT", "8000")
    env = os.environ.copy()
    env.update(
        {
            "QA_RUN_ID": run.id,
            "QA_RUN_BASE_URL": run.base_url,
            "QA_RUN_ROUTES": json.dumps(run.requested_routes or []),
            "QA_RUN_ROLES": json.dumps(run.requested_roles or []),
            "QA_CP_URL": f"http://127.0.0.1:{port}/api/v1",
            "QA_API_TOKEN": settings.api_token,
        }
    )
    subprocess.Popen(
        ["npx", "tsx", "src/runner.ts"],
        cwd=str(_BROWSER_WORKER_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
