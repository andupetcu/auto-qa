# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Monorepo implementing the Auto QA autonomous QA system, **v0.1 dev stack**: `control-plane/` (Python 3.12, FastAPI + SQLite + local-disk artifacts + MCP), `browser-worker/` (TypeScript, Playwright), `docs/` (design suite). **v0.1 owner constraints: no Docker (ever), no Temporal, no SeaweedFS/Postgres — PM2 + SQLite + subprocess orchestration.** See `docs/plans/v0.1-plan.md` for the authoritative v0.1 architecture, contracts, and probed facts about the dev target. Development is test-first: the pytest/vitest suites are the contract; don't change tests to fit code.

**Read `docs/00-implementation-guide.md` first** — it is the master document; every other doc is referenced from it. The architecture doc under `docs/` is the authoritative long-term architecture; where v0.1 deviates (infra only, not contracts), `docs/plans/v0.1-plan.md` wins.

## Non-negotiable ground rules (from docs/00)

1. **Zero inference calls inside the QA system.** No LLM client, no model config, no API keys anywhere in this codebase. All reasoning (failure analysis, fix authoring, exploratory strategy) belongs to the external Hermes agent system, reached only via MCP and webhooks. If an implementation path seems to need a model, the design is being misread.
2. **Do not add features, endpoints, tables, or MCP tools not present in the doc suite.** Missing things are deliberately deferred (diff-aware selection, synthetic monitoring, i18n matrix, ZAP, RUM, chaos injection) — stop and flag instead of building.
3. **The QA system never touches the app's code.** Fixing (authoring, applying, deploying) is entirely Hermes-side; this system only reports failures and verifies via reruns. (The docs' fix gate / PR loop is out of scope — see the scope correction below.)
4. Every filter cap and behavioral limit comes from config (`QA_*` env vars, defaults in docs/00), never hardcoded.
5. Component licenses in the architecture doc's component table are load-bearing — do not substitute components (e.g. SeaweedFS not MinIO, OpenBao not Vault) without flagging.

## Architecture

Flow (v1 scope): trigger → discover routes → mint role sessions → execute Playwright suite → capture artifacts → deterministic post-processing → emit `FailureBundle` → Hermes analyzes and fixes on its side → Hermes deploys → Hermes requests `rerun` to verify.

Components: FastAPI control plane + FastMCP server (single bearer token auth), Temporal (namespace `qa`) for durable runs, Postgres (schema in `docs/01-schema.sql`), SeaweedFS artifact store (signed URLs only, never inline artifacts), Forgejo for branches/PRs.

**Scope revision (owner decision, 2026-08-14 — now reflected throughout the doc suite; the authoritative statement is in `docs/00-implementation-guide.md` §"Scope revision"):**

- The application under test is a **deployed app reached over HTTPS only** — base URLs are supplied at run time by the operator or Hermes (`QA_BASE_URL_DEFAULT` is only a default). The QA system gets **no access to the app's source code** in the initial production version.
- **Fixing is entirely Hermes-side.** The Hermes LLM agent layer authors, applies, and deploys fixes outside this system. The QA system's responsibility ends at emitting `FailureBundle`s and re-running suites on request (`rerun`, optionally against a new `base_url`, is the verification path after Hermes deploys a fix).
- Deferred and marked as such in the docs: doc 07 in full (gate, git/PR), `submit_fix_proposal`, `FixLoopWorkflow`, the `fix_proposal`/`loop_attempt` tables, `QA_GATE_*`/`QA_LOOP_*`/`QA_FORGEJO_*` config, the Forgejo compose service, and the `gate.*`/`loop.*`/`rerun.verified` events.
- Runs are identified by `base_url` + optional advisory `app_version` (supplied in the run request), replacing `git_sha`/`branch`.
- `promote_candidate` survives without git: it marks the candidate promoted and returns a generated `test()` block for manual addition to `tests/suites/`.
- Source-map resolution still applies, provided the deployed app serves its source maps.

### Language boundary (strict)

- **Python owns:** HTTP API, MCP server, all Postgres writes, fix gate, git ops, events/webhooks, Temporal workflow definitions.
- **TypeScript owns:** everything touching a browser or artifact bytes — Playwright execution, capture, HAR/console filtering, source-map resolution, clustering inputs, contact sheets.
- They meet **only** through two Temporal task queues (`qa-control` = Python activities, `qa-browser` = TypeScript activities) with plain-JSON payloads, plus S3/Postgres. TypeScript never writes Postgres directly — only via control-plane HTTP endpoints marked `internal` in the OpenAPI spec.

### Key conventions

- IDs are prefixed lowercase ULIDs (`run_`, `res_`, `fb_`, `fp_`, `cl_`, `ct_`, `rt_`, …), generated only by the control plane.
- Temporal workflow ID = run ID, giving exactly-once run execution; `POST /runs` also honors an `Idempotency-Key` header; `submit_fix_proposal` is idempotent on `(bundle_id, sha256(diff))`.
- Control-plane errors are RFC 9457 problem+json. Retry policies live in Temporal activity definitions (doc 04) — no ad-hoc retries inside activities.
- Browser errors are test failures, never workflow failures — except `AUTH_EXPIRED`, which fails the run fast with `status='auth_expired'` so stale sessions are never classified as app bugs.
- Flaky failures (don't reproduce over N reruns) are quarantined and **never** sent to Hermes. Failures are clustered by deterministic signature hash; Hermes gets one exemplar per cluster.
- All artifacts handed to Hermes must first pass the deterministic reduction pipeline (doc 06): HAR/console filtering with caps, source-map resolution to real `file:line`, contact-sheet compositing.

### The fix gate (doc 07) — OUT OF SCOPE in v1

Doc 07 describes a mechanical gate (category allowlist, blast-radius limits, path denylist, apply-to-branch, PR, loop guardrails) for validating Hermes-authored diffs inside the QA system. Per the scope correction above, fixing lives entirely in the Hermes layer — do not implement doc 07 unless the owner explicitly brings it back in scope.

## Document map

| Doc | Contents |
|---|---|
| `00-implementation-guide.md` | Repo layout, conventions, config vars, build order, per-stage definition of done |
| `01-schema.sql` | Complete Postgres DDL (Alembic migrations are generated FROM this) |
| `02-control-plane-api.yaml` | OpenAPI 3.1 spec for the control plane |
| `03-mcp-server.md` | 13 MCP tools, handlers, auth, tool→endpoint mapping |
| `04-temporal-workflows.md` | SuiteRun/Discovery/Exploratory/FixLoop/Retention workflows, task queues, retry policies, cross-language activity signatures |
| `05-playwright-workers.md` | Worker image, Playwright project, per-role `storageState` auth, role-matrix generation from `role-matrix.yaml` |
| `06-postprocessing.md` | HAR/console filters, source-map resolution, signature clustering, flake reruns, severity rules, contact sheets |
| `07-fix-gate.md` | Gate check order, category recomputation, branch/PR/revert mechanics |
| `08-docker-compose.yaml` | Full deployment manifest |
| `09-events-webhooks.md` | HMAC-signed webhook envelope and event catalog |

## Build order

Implement in the roadmap stages (docs/00 §"Build order"), each with a verifiable definition of done: (1) deterministic core — schema, Playwright project runnable standalone via `npx playwright test`, role matrix; (2) discovery + post-processing pipeline; (3) Temporal workflows + MCP server + webhooks; (4) exploratory sessions with candidate promotion — the gated fix loop half of Stage 4 is out of scope per the scope correction. Do not skip ahead: each stage gates the next (e.g. Stage 1 requires flake rate <5% over 20 runs).

## Commands

- Control-plane tests: `cd control-plane && .venv/bin/python -m pytest -q` (venv created with `uv venv --python 3.12`; system python3 is 3.14 with broken ensurepip — use uv)
- Worker unit tests: `cd browser-worker && npx vitest run`; type-check with `npx tsc --noEmit`
- Live Playwright suite against the dev app: `cd browser-worker && set -a && source ../.env && set +a && npx playwright test --config tests/playwright.config.ts`
- Serve the control plane: `pm2 start ecosystem.config.js` (or `.venv/bin/uvicorn app.main:app --app-dir control-plane --port 8787` for foreground)
- Secrets/dev credentials live in the gitignored `.env` at repo root (`.env.example` has the shape). Never commit credentials.
