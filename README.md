# Auto QA

Self-hosted autonomous QA for your web app. A deterministic
tool-and-artifact layer — **zero LLM calls inside** — driven by the Hermes agent layer
over MCP, with a web console for humans. Dev stack: FastAPI + SQLite + local-disk
artifacts + Playwright + a React/Fluent UI, run under PM2. **No Docker.**

The QA system tests deployed apps over HTTPS; it has no access to app source and never
authors fixes — that's Hermes-side. It executes suites, captures artifacts, quarantines
flaky failures, clusters genuine ones into FailureBundles, and reports.

## Run it

```bash
cp .env.example .env         # fill in token, target URL, and test-account credentials
npx pm2 start ecosystem.config.js
```

The control plane serves on `http://127.0.0.1:8787`:

- **Web UI** at `/ui` — auto-connects (local-only; the control plane injects the API
  token into the same-origin page, no login). Runs, run detail with live progress + Stop,
  result/bundle drawers, projects (schedule, parallelism, write-only credentials), route
  matrix, coverage.
- **REST API** at `/api/v1` (bearer `QA_API_TOKEN`).
- **MCP** (Streamable HTTP, same token) at `/mcp` — 12 tools: `capabilities, list_routes,
  list_projects, create_project, update_project, run_suite, get_run_status,
  get_failure_bundles, get_console_logs, get_har, get_artifacts, rerun`.
- **Signed artifact URLs** at `/artifacts/...` (the only unauthenticated path).

Trigger a run from the CLI:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/runs \
  -H "Authorization: Bearer $QA_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"project":"my-app","routes":["ALL"],"roles":["user","anon"]}'
```

Runs execute against the project's deployment, capture trace/HAR/console per test,
quarantine flaky failures via isolated reruns, cluster genuine failures by signature, and
emit FailureBundles with signed artifact URLs. Live progress (phase + per-test counts) is
posted back during the run; `POST /runs/{id}/cancel` kills the worker's whole process tree.
Webhooks (`run.started|completed|failed`, HMAC-signed) go to `QA_WEBHOOK_URLS`.

## Projects

A **project** is an independently-testable target (its own base URL, routes, role matrix,
selectors, roles, schedule, parallelism, and credentials). A default project is
seeded from config. Agents create and manage projects autonomously over MCP; a project
becomes runnable once its credentials are set — either via the UI's write-only credentials
form (`PUT /projects/{id}/credentials` → chmod-600 `.env.credentials`, never in the DB) or
by adding `QA_CRED_*` values to `.env`. Project/role names are constrained to a safe slug.
Projects with a `schedule_cron` run on an in-process scheduler.

## Development

```bash
cd control-plane && .venv/bin/python -m pytest -q     # 93 tests   (venv via `uv venv --python 3.12`)
cd browser-worker && npx vitest run && npx tsc --noEmit # 69 tests + types
cd web-ui        && npm run build                     # type-check + bundle to dist/ (served at /ui)

# live Playwright suite directly (bypasses the control plane)
cd browser-worker && set -a && source ../.env && set +a && \
  npx playwright test --config tests/playwright.config.ts
```

Test-first repo: the pytest/vitest suites are the contract — don't bend tests to code.
Route list: `browser-worker/tests/routes.config.yaml`. Role expectations:
`browser-worker/tests/role-matrix.yaml` (SPA semantics: `redirect` = client-side auth
gate, not HTTP redirect). All app selectors are env-overridable (`QA_SEL_*`, or per-project
`selectors`) so Hermes can supply its own per environment.

## Layout

- `control-plane/` — FastAPI REST + MCP server, SQLite, clustering, gate-free run
  orchestration (subprocess workers), scheduler, signed artifacts, webhooks.
- `browser-worker/` — Playwright project (per-role auth, route×role matrix, capture) and
  the run orchestrator (flake reruns, post-processing, progress reporting, ingest).
- `web-ui/` — React 18 + Vite + Fluent UI v9 console, served static at `/ui`.

Design docs (`docs/`) are kept local, not published.
