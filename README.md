# footprints-auto-qa

Self-hosted autonomous QA for the Footprints AI platform. Deterministic tool-and-artifact
layer — **zero LLM calls inside** — driven by the Hermes agent layer over MCP.
v0.1 dev stack: FastAPI + SQLite + local-disk artifacts + Playwright, run under PM2.
No Docker. Design docs in `docs/`; v0.1 architecture in `docs/plans/v0.1-plan.md`.

## Run it

```bash
cp .env.example .env         # fill in token, secrets, credentials, target URL
npx pm2 start ecosystem.config.js
```

The control plane serves on `http://127.0.0.1:8787`:

- REST API at `/api/v1` (bearer token from `QA_API_TOKEN`)
- MCP (Streamable HTTP, same bearer token) at `/mcp` — 9 tools:
  `capabilities, list_routes, run_suite, get_run_status, get_failure_bundles,
  get_console_logs, get_har, get_artifacts, rerun`
- Signed artifact URLs at `/artifacts/...` (the only unauthenticated path)

Trigger a run:

```bash
curl -X POST http://127.0.0.1:8787/api/v1/runs \
  -H "Authorization: Bearer $QA_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"routes":["ALL"],"roles":["user","anon"]}'
```

Runs execute against the deployed app (`base_url` per run, default `QA_BASE_URL_DEFAULT`),
capture trace/HAR/console per test, quarantine flaky failures via isolated reruns, cluster
genuine failures by signature, and emit FailureBundles with signed artifact URLs. Webhooks
(`run.started|completed|failed`, HMAC-signed) go to `QA_WEBHOOK_URLS`.

## Development

```bash
cd control-plane && .venv/bin/python -m pytest -q     # 42 tests
cd browser-worker && npx vitest run                   # 55 tests
cd browser-worker && npx tsc --noEmit                 # types

# live Playwright suite directly (bypasses the control plane)
cd browser-worker && set -a && source ../.env && set +a && \
  npx playwright test --config tests/playwright.config.ts
```

Test-first repo: the pytest/vitest suites are the contract — don't bend tests to code.
Route list: `browser-worker/tests/routes.config.yaml`. Role expectations:
`browser-worker/tests/role-matrix.yaml` (SPA semantics: `redirect` = client-side auth
gate, not HTTP redirect). All app selectors are env-overridable (`QA_SEL_*`) so Hermes
can supply its own per environment.
