# Auto QA v0.2–v0.5 Update Plan

Status: owner-approved implementation plan
Approved direction: 2026-08-14
Target deployment: `/opt/auto-qa` on `192.168.68.69`

## 1. Purpose

Evolve Auto QA from a deterministic suite launcher into a frontend QA control plane that an external Hermes agent can use to:

1. inspect a deployed frontend interactively;
2. capture evidence and reproduce failures;
3. convert reviewed exploration into deterministic scenarios;
4. run those scenarios manually or on durable schedules;
5. diagnose regressions entirely through MCP and signed artifacts.

Auto QA remains a deterministic execution system. It does not contain an LLM, modify application source code, or make product decisions.

## 2. Current baseline

The deployed v0.1 system already provides:

- FastAPI control plane with bearer authentication;
- SQLite metadata and local-disk artifacts;
- Playwright subprocess runner;
- project, route, role and matrix configuration;
- per-project cron scheduling in UTC;
- run progress, cancellation and reruns over REST;
- result, console, HAR, artifact and failure-bundle REST endpoints;
- 12 MCP tools for projects, route discovery, suite execution and evidence retrieval;
- PM2 lifecycle and a LAN web UI.

The main current gaps are:

- no atomic browser-control MCP contract;
- no deterministic scenario model;
- incomplete MCP parity with existing run/result REST APIs;
- schedule controls are embedded in project CRUD and not exposed as an operator contract;
- no visual, accessibility or performance baselines;
- limited operational health and notification controls.

## 3. Non-negotiable invariants

1. **Zero inference inside Auto QA.** Hermes owns reasoning; Auto QA owns deterministic execution.
2. **Deployed targets only.** Auto QA receives an HTTPS base URL and never reads the target application's repository.
3. **No arbitrary executable code.** MCP clients cannot submit JavaScript, Python, shell, `eval`, browser `evaluate`, or filesystem paths.
4. **One action engine.** Interactive actions and scheduled scenarios use the same validated action/assertion schema.
5. **Isolation by default.** Each browser session has a dedicated Playwright context, role storage state, TTL and cleanup path.
6. **Secrets never cross MCP.** Tools accept project/role references, not credentials; artifacts and logs are deterministically redacted.
7. **Target allowlists.** Navigation, redirects and subresources are constrained by project policy before broad network targets are supported.
8. **Deterministic waits.** Semantic locators, explicit state assertions and bounded timeouts replace sleeps.
9. **Artifacts by reference.** Binary evidence remains on the artifact store and is returned through expiring signed URLs.
10. **Durable state transitions.** Runs, schedules and scenarios have idempotent creation, terminal-state guards and recoverable leases.
11. **Backward compatibility.** Existing REST endpoints, MCP tools, FAI project data and completed runs continue to work.
12. **No automatic baseline approval.** Visual or behavior baselines require explicit operator approval.

## 4. Delivery strategy

Every phase is a vertical slice:

1. add or update the public contract;
2. write a failing public-interface test;
3. implement the smallest behavior that passes;
4. run backend, worker and UI regression gates;
5. verify through the real LAN MCP endpoint;
6. deploy only after the phase is green;
7. create a conventional commit; never push without owner approval.

## 5. Phase 1 — MCP parity and durable operator controls

Goal: eliminate SSH/database fallback for normal run and schedule operations.

### 5.1 MCP additions

- `get_run_results`
  - filters: status, role, route, browser, flaky;
  - optional inclusion of console/network summaries and artifact metadata;
  - bounded result limit.
- `cancel_run`
  - invokes the existing terminal-state-safe REST cancellation endpoint.
- extend `rerun`
  - preserve existing failed/affected/full scopes;
  - support a single `result_id` retry by resolving its route and parent run.
- `list_schedules`
- `get_schedule`
- `create_schedule`
- `update_schedule`
- `pause_schedule`
- `resume_schedule`
- `run_schedule_now`
- `get_schedule_history`

### 5.2 Initial schedule model

Phase 1 deliberately wraps the existing one-schedule-per-project persistence rather than adding a second scheduler table prematurely.

A schedule consists of:

- stable ID derived from project ID (`sched_<project-id-suffix>`);
- project name;
- cron expression;
- timezone fixed to `UTC` in Phase 1;
- enabled/paused state;
- base URL inherited from project;
- all configured project routes and roles;
- overlap policy fixed to `skip`;
- next run and last scheduled timestamps;
- history derived from runs where `trigger == "schedule"`.

Phase 3 introduces independent multi-schedule records after scenarios exist.

### 5.3 REST additions

Add dedicated schedule routes so MCP is a thin adapter rather than business logic:

- `GET /api/v1/schedules`
- `GET /api/v1/schedules/{project}`
- `PUT /api/v1/schedules/{project}`
- `PATCH /api/v1/schedules/{project}`
- `POST /api/v1/schedules/{project}/pause`
- `POST /api/v1/schedules/{project}/resume`
- `POST /api/v1/schedules/{project}/run`
- `GET /api/v1/schedules/{project}/history`

### 5.4 Safety and validation

- validate cron expressions at write time;
- reject empty cron values on schedule creation;
- reject unknown projects;
- terminal runs cannot be canceled;
- retrying a non-route suite result returns a clear problem response;
- result queries enforce configurable limits;
- MCP handlers make one authenticated in-process REST call each.

### 5.5 Acceptance gate

- Public API tests cover all success/error transitions.
- MCP discovery contains all Phase 1 tools.
- MCP round-trip tests cover results, cancel, schedule pause/resume/run/history.
- Existing backend, worker, type and UI build suites stay green.
- LAN `hermes mcp test auto-qa` succeeds.
- A real FAI anonymous smoke run is created, observed and queried through MCP.

## 6. Phase 2 — Interactive browser sessions

Goal: allow Hermes to inspect and reproduce frontend behavior through bounded atomic actions.

### 6.1 Session contract

Add an ephemeral `BrowserSession` lifecycle:

- session ID, project, role, browser, viewport;
- created/last-used/expiry timestamps;
- status and worker PID;
- current URL/title;
- dedicated browser context and artifact workspace;
- explicit close plus TTL cleanup.

### 6.2 MCP tools

- `browser_session_create`
- `browser_navigate`
- `browser_snapshot`
- `browser_screenshot`
- `browser_click`
- `browser_type`
- `browser_select`
- `browser_press`
- `browser_scroll`
- `browser_wait`
- `browser_assert`
- `browser_console`
- `browser_network`
- `browser_close`

### 6.3 Selector contract

Actions accept only validated locator forms:

- accessibility role + accessible name;
- label text;
- placeholder;
- test ID;
- visible text;
- element reference returned by the latest snapshot.

Raw CSS/XPath may be added later behind explicit project policy. Browser `evaluate` is forbidden.

### 6.4 Worker architecture

- Node/Playwright owns all browser bytes and actions.
- Python owns session metadata and authorization.
- A session-scoped worker communicates through newline-delimited JSON over local stdio or a Unix socket.
- Commands and responses are schema-versioned.
- Worker death deterministically transitions the session to `failed`.

### 6.5 Acceptance gate

- concurrent sessions do not share cookies or storage;
- expired sessions are killed and cleaned;
- disallowed navigation fails before browser access;
- every action emits an audit entry;
- a complete anonymous FAI navigation/click/assert flow runs only through MCP;
- no session tool accepts executable code.

## 7. Phase 3 — Deterministic scenarios and independent schedules

Goal: promote reviewed interactive work into reusable, schedulable tests.

### 7.1 Scenario model

Versioned declarative schema containing:

- project and role;
- initial route;
- browser/viewport defaults;
- ordered actions/assertions;
- per-step timeout and evidence policy;
- tags, owner and enabled state;
- immutable revision and content hash.

### 7.2 MCP tools

- `scenario_draft_from_session`
- `scenario_validate`
- `scenario_create`
- `scenario_update`
- `scenario_list`
- `scenario_run`
- `scenario_disable`
- `scenario_history`

### 7.3 Independent schedule model

Replace the Phase 1 project wrapper with durable schedules that can target suites or scenario revisions:

- cron plus IANA timezone;
- overlap policy: skip, queue or replace;
- timeout and bounded retry policy;
- browser/role/viewport matrix;
- notification and artifact-retention policy;
- enabled/paused state;
- last/next fire and lease owner;
- pinned scenario revision/runtime version.

Existing project cron values migrate automatically to equivalent schedules.

### 7.4 Acceptance gate

- recorded session can produce a valid draft but cannot auto-approve it;
- approved scenario replays deterministically;
- scheduler restart does not duplicate a fire boundary;
- overlap policy is enforced under concurrent ticks;
- scenario revision used by each run is immutable and recorded.

## 8. Phase 4 — Evidence and quality gates

### 8.1 Evidence bundles

Capture and expose:

- failure and full-page screenshots;
- Playwright trace;
- bounded video;
- reduced HAR and failed requests;
- console errors/warnings;
- DOM excerpt and accessibility snapshot;
- redirect chain and current URL;
- failed step and selector-resolution details;
- runtime/browser/app versions.

### 8.2 Visual regression

- per project/route/scenario/browser/viewport baseline;
- pixel and perceptual comparison;
- dynamic masks and thresholds;
- propose/approve/reject lifecycle;
- never auto-approve after failure.

### 8.3 Accessibility

- axe-core WCAG AA rules;
- keyboard navigation and focus checks;
- issue selector, impact, rule and remediation evidence.

### 8.4 Performance

- navigation timing and resource budget;
- LCP, CLS and long-task summaries where deterministic;
- absolute thresholds and comparison to previous successful run;
- sustained-regression policy to reduce noise.

### 8.5 Acceptance gate

- each failure type has a bounded evidence bundle;
- signed artifact URLs expire and reject tampering;
- visual baselines require explicit approval;
- accessibility/performance regressions are queryable and schedule-reportable.

## 9. Phase 5 — Notifications, health and operations

### 9.1 Change-aware notifications

Notify on:

- new failure;
- recovered failure;
- severity increase;
- flaky-rate threshold;
- visual/accessibility/performance regression;
- scheduler or worker unhealthy.

Do not notify repeatedly for unchanged persistent failures unless configured.

### 9.2 Health MCP/API

- control-plane/runtime versions;
- scheduler heartbeat and lease state;
- queue depth and active runs/sessions;
- browser worker health;
- disk/artifact retention status;
- oldest queued run and last schedule completion.

### 9.3 Acceptance gate

- notification deduplication and recovery events are tested;
- scheduler/worker failure is observable without SSH;
- retention cleanup cannot delete active artifacts;
- operational status is available through MCP and UI.

## 10. UI roadmap

- Phase 1: schedule controls and case-level filters remain integrated into current Projects/Run pages.
- Phase 2: interactive session workspace with live snapshot, screenshot and action timeline.
- Phase 3: scenario editor, revision diff and schedule editor.
- Phase 4: visual baseline approval, accessibility and performance views.
- Phase 5: operational health and notification policy pages.

The UI remains an operator surface over the same REST contracts used by MCP.

## 11. Security backlog tied to phases

- replace LAN HTML token injection with a real local operator login before any non-LAN exposure;
- configure project target/subresource allowlists before authenticated exploration;
- redact credentials, authorization headers, cookies and configured selectors from all evidence;
- enforce artifact size/retention limits;
- validate redirects against project policy;
- audit every MCP mutation with tool name, subject ID and outcome;
- keep MCP DNS-rebinding protection and exact allowed hosts enabled.

## 12. Initial FAI schedule after Phase 1

No schedule is enabled automatically during implementation. After owner approval:

- every 15 minutes: anonymous Chromium smoke for the four configured public routes;
- nightly: expanded viewport, console/network and accessibility pass after Phase 4;
- notify only on new failure and recovery.

## 13. Explicitly deferred

- application source-code access or automated fixes;
- arbitrary browser JavaScript execution;
- Kubernetes, Docker, Temporal, Postgres or distributed queues;
- automatic visual baseline acceptance;
- autonomous destructive flows;
- Firefox/WebKit scheduling before Chromium stability gates pass;
- public internet exposure of the Auto QA control plane.
