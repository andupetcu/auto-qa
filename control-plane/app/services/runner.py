"""Spawn the browser-worker runner as a detached subprocess (runner_mode="subprocess")."""
import json
import logging
import os
import signal
import subprocess
from pathlib import Path

from app.db import Project, TestRun
from app.settings import Settings

logger = logging.getLogger(__name__)

# control-plane/app/services/runner.py -> repo root is parents[3]
_REPO_ROOT = Path(__file__).resolve().parents[3]
_BROWSER_WORKER_DIR = _REPO_ROOT / "browser-worker"


def build_spawn_env(run: TestRun, project: Project, settings: Settings) -> dict[str, str]:
    """Pure: the full set of env vars the worker subprocess needs for this run."""
    port = os.environ.get("QA_CP_PORT", "8787")
    return {
        "QA_RUN_ID": run.id,
        "QA_RUN_BASE_URL": run.base_url,
        "QA_RUN_ROUTES": json.dumps(run.requested_routes or []),
        "QA_RUN_ROLES": json.dumps(run.requested_roles or []),
        "QA_CP_URL": f"http://127.0.0.1:{port}/api/v1",
        "QA_API_TOKEN": settings.api_token,
        "QA_ARTIFACTS_DIR": str(Path(settings.artifacts_dir).resolve()),
        "QA_RUN_PROJECT": project.name,
        "QA_RUN_SELECTORS": json.dumps(project.selectors or {}),
        "QA_RUN_ROLE_MATRIX": json.dumps(project.role_matrix or {}),
        "QA_RUN_ROLES_CONFIG": json.dumps(project.roles or []),
    }


def maybe_spawn(run: TestRun, project: Project, settings: Settings) -> None:
    """Best-effort spawn of the worker runner. Never raises - failures are logged only."""
    if settings.runner_mode != "subprocess":
        return
    try:
        _spawn(run, project, settings)
    except Exception:
        logger.exception("failed to spawn browser-worker runner for run_id=%s", run.id)


def _load_credentials_env(settings: Settings) -> dict[str, str]:
    """Per-project credentials written by PUT /credentials live in a separate secrets
    file (not the control plane's own env), so load them for the worker subprocess."""
    path = Path(settings.credentials_file)
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, _, v = s.partition("=")
            out[k.strip()] = v.strip()
    return out


def _spawn(run: TestRun, project: Project, settings: Settings) -> None:
    env = os.environ.copy()
    env.update(_load_credentials_env(settings))
    env.update(build_spawn_env(run, project, settings))
    log_dir = _REPO_ROOT / "var" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log = open(log_dir / f"runner-{run.id}.log", "ab")
    proc = subprocess.Popen(
        ["npx", "tsx", "src/runner.ts"],
        cwd=str(_BROWSER_WORKER_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,  # new process group so we can kill the whole tree
    )
    run.worker_pid = proc.pid


def kill_worker(pid: int | None) -> None:
    """Hard-kill the worker's entire process tree (tsx + npx + Playwright + browsers).

    Walk the tree with psutil rather than trusting the process group — the nested
    npx→node→playwright→browser chain re-parents/re-groups and escapes killpg. SIGKILL
    every descendant because an explicit user Stop must be decisive. Best-effort.
    """
    if not pid:
        return
    try:
        import psutil

        try:
            parent = psutil.Process(pid)
        except psutil.NoSuchProcess:
            return
        victims = parent.children(recursive=True) + [parent]
        for proc in victims:
            try:
                proc.kill()
            except psutil.NoSuchProcess:
                pass
        psutil.wait_procs(victims, timeout=3)
    except Exception:  # psutil missing or racey tree — fall back to the process group
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
