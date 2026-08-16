# Auto QA Readiness, Lifecycle Evidence, and Diagnostics Implementation Plan

## Status

Implementation plan for the next Auto QA slice. This document is intentionally application-agnostic: target-specific selectors and request patterns are configuration, never worker code.

## Objectives

1. Preserve a bounded visual timeline across navigation, loading, animation, assertion, settlement, and timeout states.
2. Make readiness, critical network completion, and browser runtime health part of the test verdict.
3. Produce deterministic evidence that explains both successful settlement and readiness failure.
4. Expose concise, redacted network/readiness/runtime summaries through REST and MCP.
5. Remove misleading opposite-role skips and preserve resolved dynamic route metadata.
6. Keep existing v1 run snapshots and visual manifests readable.

## Current architecture and gaps

- `browser-worker/tests/fixtures.ts` owns HAR/console recording and visual lifecycle hooks.
- `VisualCaptureSession` already captures bounded/deduplicated frames and builds contact sheets, but only labels navigation, DOM ready, configured delays, and assertion.
- `filterHar` runs only for failed results and ignores response status `-1`, so passing runs can hide unfinished requests.
- `runner.ts` stores console/network summaries only for non-flaky failures.
- `matrix.spec.ts` declares every role case in every Playwright project, creating expected skip noise.
- `reportParser.ts` derives routes from matrix titles, leaving dynamic suite routes null.
- The control plane persists immutable `capture_config`; project `selectors` can supply project defaults without a schema migration.
- The visual manifest is schema v1 and does not include readiness, runtime, pending-request, or frame-state metadata.

## Design decisions

### 1. Immutable readiness policy

Extend capture policy with a bounded `readiness` object. The normalized snapshot remains stored on `TestRun.capture_config` and passed unchanged to the worker.

Policy fields:

- `enabled`
- `timeoutMs`
- `pollIntervalMs`
- `captureIntervalMs`
- `stabilityWindowMs`
- `visualDiffRatio`
- `readySelectors[]`
- `loadingSelectors[]`
- `criticalRequests[]`
- `ignoredRequests[]`
- `failOnPageError`
- `failOnConsoleError`
- `failOnCriticalRequest`

Request matching uses escaped glob patterns plus bounded method/resource-type lists. Arbitrary regular expressions are not accepted.

Project defaults may be supplied as `project.selectors.readiness`; an explicit run capture policy overrides them. The merged canonical policy is persisted in the run snapshot.

### 2. Lifecycle capture and readiness monitor

Add a worker `ReadinessMonitor` that starts before navigation and tracks:

- pending critical fetch/XHR requests;
- completed/failed critical requests;
- response status classes;
- page errors and console errors;
- visible loading selectors;
- required ready selectors;
- bounded visual stability samples.

Capture remains active throughout the lifecycle. Milestones become:

- `navigation`
- `domcontentloaded`
- `delay`
- `loading`
- `critical-response`
- `asserted`
- `settled`
- `timeout`

Event-driven frames and interval frames share the existing queue, frame cap, masking, hash deduplication, pixel budget, and byte budget.

Readiness controls the verdict, not capture. On timeout, Auto QA retains the timeline and timeout frame, attaches the manifest/contact sheet/final screenshot, and then fails fixture teardown with a deterministic readiness error.

### 3. Visual manifest v2

Write manifest schema v2 while retaining v1 read compatibility. Add:

- per-frame `elapsedMs`, `readinessState`, `pendingCriticalRequests`, and `visibleLoadingSelectors`;
- top-level readiness status and policy version;
- settlement/timeout timestamps and stability metrics;
- critical request counts and bounded abnormal-request summaries;
- browser runtime collector status/counts;
- explicit evidence state: `captured_settled`, `captured_unsettled`, `capture_failed`, or `not_applicable`.

Contact-sheet labels show relative elapsed time, milestone, readiness state, and pending-request count.

### 4. HAR and runtime diagnostics

Replace failure-only HAR filtering with an analyzer executed for every result. Preserve backward-compatible abnormal-entry lists while adding a bounded summary record containing:

- collector status;
- total/status counts;
- pending (`status <= 0`) count;
- request-failure count;
- 4xx/5xx count;
- slow critical count.

Pending/failed critical requests influence the readiness verdict. Static/background traffic can be ignored by project policy; matching rules remain visible in the immutable policy snapshot.

Console parsing also runs for every result. Runtime summaries distinguish collector success with zero events from missing collection.

### 5. REST and MCP projections

Add structured read-only projections:

- `GET /results/{id}/network-summary`
- `GET /results/{id}/runtime-summary`
- enrich existing visual-evidence output with manifest readiness/evidence state
- MCP `get_network_summary`
- MCP `get_runtime_summary`
- MCP `get_readiness_summary`

All projections use already-redacted persisted data and existing authentication. Raw artifact access remains signed and integrity-checked.

### 6. Result and coverage correctness

- Discard only opposite-project matrix skips before ingestion; preserve genuine applicable skips.
- Resolve null dynamic routes from the final manifest route URL.
- Add executed routes/roles/browsers/viewports and applicable/pass/fail/skip counts to run coverage projection.
- Never imply unconfigured browser, viewport, role, or route coverage.

## TDD sequence

1. Control-plane tests for policy normalization, bounds, glob validation, project-default merge, and immutable snapshots.
2. Worker unit tests for request classification, pending lifecycle, selector readiness, visual stability, timeout, and deterministic summaries.
3. Worker tests proving loading/animation frames are retained before settlement and on timeout.
4. Manifest/contact-sheet tests for schema v2, frame metadata, evidence states, deterministic output, and v1 compatibility.
5. Runner/parser tests for all-result diagnostics, opposite-role skip removal, and dynamic route recovery.
6. REST/MCP contract tests for new summaries, auth, redaction, bounds, and missing evidence.
7. Full control-plane, worker, TypeScript, UI lint/build, and production dependency audit.

## Live verification gates

1. Deploy and restart PM2 only after automated gates pass.
2. Run MCP `ALL` using the configured routes/roles/browser/viewport.
3. Require zero applicable failures and zero pending critical requests.
4. Inspect every manifest/contact sheet and verify loading, intermediate, and settled/timeout stages are represented.
5. Verify final evidence status is `captured_settled` for passing cases.
6. Verify console/page-error/request-failure collectors report explicitly.
7. Download representative signed artifacts and verify hashes/byte counts.
8. Inspect HAR summaries for pending critical requests, 4xx/5xx, and redaction.
9. Confirm PM2 and runner logs contain no startup/runtime errors.
10. Review Git diff and generated files; do not commit or push without fresh authorization.

## Compatibility and rollout

- Existing v1 manifests remain readable through the control-plane projection.
- Existing capture snapshots without `readiness` receive bounded defaults in the worker.
- No database migration is required; canonical readiness policy lives in existing JSON fields.
- Failure behavior changes only for critical traffic/runtime conditions selected by normalized policy.
- If the live project needs exceptions for polling or long-lived requests, configure safe ignored globs rather than weakening global defaults.

## Done criteria

The slice is complete only when automated suites pass, the service is restarted, a fresh MCP `ALL` run produces a bounded lifecycle matrix with settled passing evidence, critical network requests are complete, summaries are available through MCP, and exact residual risks are documented.