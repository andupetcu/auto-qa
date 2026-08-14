"""Per-project run creation locks for the single-process v0.x control plane."""

from __future__ import annotations

import threading

_registry_guard = threading.Lock()
_project_locks: dict[str, threading.RLock] = {}


def project_run_lock(project_id: str) -> threading.RLock:
    """Return the process-local re-entrant lock for one project."""
    with _registry_guard:
        return _project_locks.setdefault(project_id, threading.RLock())
