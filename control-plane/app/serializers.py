"""Shared row -> dict serializers used across routers."""
from app.db import TestResult, TestRun


def _iso(dt):
    return dt.isoformat() if dt is not None else None


def serialize_run(run: TestRun, project_name: str | None = None) -> dict:
    return {
        "id": run.id,
        "project": project_name,
        "base_url": run.base_url,
        "app_version": run.app_version,
        "trigger": run.trigger,
        "requested_routes": run.requested_routes,
        "requested_roles": run.requested_roles,
        "browsers": run.browsers,
        "viewports": run.viewports,
        "capture_config": run.capture_config,
        "status": run.status,
        "started_at": _iso(run.started_at),
        "ended_at": _iso(run.ended_at),
        "totals": run.totals,
        "parent_run_id": run.parent_run_id,
        "detail": run.detail,
    }


def serialize_result(result: TestResult) -> dict:
    return {
        "id": result.id,
        "run_id": result.run_id,
        "test_name": result.test_name,
        "test_file": result.test_file,
        "route_path": result.route_path,
        "role": result.role,
        "browser": result.browser,
        "viewport": result.viewport,
        "status": result.status,
        "duration_ms": result.duration_ms,
        "flaky": result.flaky,
        "reruns_attempted": result.reruns_attempted,
        "reruns_failed": result.reruns_failed,
        "failed_action": result.failed_action,
        "shell_rendered": result.shell_rendered,
        "console_summary": result.console_summary,
        "network_summary": result.network_summary,
        "dom_excerpt": result.dom_excerpt,
        "signature_input": result.signature_input,
        "created_at": _iso(result.created_at),
    }
