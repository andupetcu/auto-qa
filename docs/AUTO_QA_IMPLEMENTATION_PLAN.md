# Auto QA Implementation Plan

**Document type:** Production implementation plan

**Date:** 2026-08-15

**Scope:** Auto QA correctness, evidence safety, visual evidence, route/scenario discovery, Hermes analysis/remediation, and quality-platform hardening

**Audited baseline:** Deployed Auto QA revision `2bf08ac` and the verified REST/UI/MCP behavior recorded during the 2026-08-14/15 audit

**Primary deployment:** `/opt/auto-qa`

---

## 1. Executive decision

Implement **Phase A (correctness and safety)** and **Phase B (Visual Evidence v0.2.1)** as the first production release.

Do not ship an isolated change from Playwright `screenshot: 'only-on-failure'` to `screenshot: 'on'`. That toggle would add passing screenshots, but it would not provide bounded loading evidence, contact sheets, visual metadata, redaction, quotas, retention enforcement, or a dependable interface for Hermes vision analysis.

The target architecture preserves the established boundary:

- **Auto QA remains deterministic:** execution, evidence capture, artifact management, schedules, reruns, findings state, and audit history.
- **Hermes owns reasoning:** visual inspection, technical diagnosis, code investigation, fix proposal, approval orchestration, implementation, deployment, and verification.
- **Application changes remain reviewable:** branch/PR based, never silent direct writes to `main`.

---

## 2. Goals

1. Produce useful visual evidence for every executed frontend case, including passing cases.
2. Capture a bounded, deterministic loading sequence rather than an unbounded video-like stream.
3. Make evidence discoverable through REST, UI, and MCP.
4. Prevent authenticated evidence from becoming an uncontrolled security or storage liability.
5. Correct known run-management and UI contract defects before expanding autonomous operation.
6. Add deterministic route and scenario discovery that Hermes can use without embedding an agent framework in Auto QA.
7. Create a persistent, auditable analysis → proposal → approval → remediation → verification workflow.
8. Establish production controls for retention, quotas, health, baselines, accessibility, and performance budgets.

---

## 3. Non-goals and constraints

### 3.1 Non-goals for the first release

- No browser × viewport Cartesian fan-out. Phase 1 continues to accept exactly one browser and one viewport per run.
- No autonomous direct commits to `main`.
- No embedded LLM or autonomous-agent framework inside Auto QA.
- No unbounded route crawling, frame capture, video retention, or artifact storage.
- No claim that static YAML route import is route discovery.
- No visual-regression auto-approval.

### 3.2 Existing behavior to preserve

- Authenticated private-route execution with persisted role storage state.
- Chromium, Firefox, and WebKit as individually selectable browsers.
- Shared per-project run-creation lock and current schedule/manual concurrency semantics.
- REST as the business interface; MCP remains a thin authenticated adapter over REST.
- Exact-result, failed, affected, and full reruns with parent-run linkage.
- Trace capture for deep debugging.
- Deterministic signatures and severity rules for technical failures.

---

## 4. Verified baseline and gaps

| Capability | Baseline | Required outcome |
|---|---|---|
| Passing screenshots | Missing | Final screenshot for every executed case |
| Loading evidence | Missing | Bounded milestone/timed frames |
| Contact sheet | Missing | One labelled chronological image per result |
| Visual manifest | Missing | Machine-readable frame metadata and relationships |
| Video | Failure-only | Keep failure-only by default; make policy explicit |
| Trace | Enabled | Preserve |
| HAR | Captured; observed at roughly 35–41 MB per successful FAI case | Redact, bound, compress or selectively retain |
| Console evidence | Raw for pass/fail; structured summary mainly on failures | Redact and expose consistently |
| Capture configuration | Accepted/stored but not passed to worker | Validated end-to-end capture policy |
| Artifact expiry | Expiry timestamps exist | Actual cleanup and quota enforcement |
| Target policy | Arbitrary base URL possible for authenticated caller | Project/installation allowlist and subresource policy |
| Default UI routes | Sends `"ALL"` | Send `["ALL"]` and test contract |
| UI run filters | Sent but ignored | Backend-enforced filters and deterministic latest-run behavior |
| Active run view | Incomplete polling | Status/results/artifacts update until terminal state |
| Route discovery | Static YAML import | Sitemap/crawler/SPA discovery with review state |
| AI diagnosis/fixes | Missing | Hermes-owned, persistent auditable workflow |
| Schedule UI | Backend/MCP present | Complete operator UI |
| MCP documentation | Stale tool count | Generated/current capability documentation |

---

## 5. Target architecture

### 5.1 Execution and evidence flow

```text
REST/UI/MCP run request
        │
        ▼
Control plane validates project + target + capture policy
        │
        ▼
Runner serializes normalized worker configuration
        │
        ▼
Playwright worker executes one browser + one viewport
        │
        ├── deterministic assertions
        ├── console + bounded network evidence
        ├── trace
        ├── final screenshot
        └── bounded loading frames
                 │
                 ▼
        Contact-sheet compositor + visual manifest
                 │
                 ▼
       Artifact ingestion, redaction checks, quotas
                 │
                 ▼
       Result APIs / signed artifacts / UI / MCP
                 │
                 ▼
      Hermes vision + code analysis when requested
```

### 5.2 Ownership boundaries

| Owner | Responsibilities |
|---|---|
| Auto QA control plane | Authentication, authorization, validation, persistence, schedules, run lifecycle, signed artifacts, findings state, audit trail |
| Browser worker | Deterministic execution, capture, local artifact production, attachment metadata |
| Web UI | Operator configuration, run status, evidence review, approval and verification views |
| Hermes | Vision analysis, evidence correlation, code inspection, proposals, approved implementation/deployment, retest orchestration |
| Application repositories | Source of truth for fixes, review history, CI, deployment artifacts |

---

# Phase A — Correctness and evidence safety

## A1. Fix the default `ALL` routes contract

### Change

Normalize the UI request to:

```json
{
  "routes": ["ALL"]
}
```

The backend must reject scalar route values with a useful validation problem, while preserving explicit route arrays.

### Code touchpoints

- `web-ui/src/drawers/NewRunDrawer.tsx`
- `control-plane/app/api/runs.py`
- related UI and API tests

### Acceptance criteria

- A default run created from the UI returns an accepted run rather than `422`.
- UI, REST, and MCP use one documented route-selector contract.
- Tests cover `["ALL"]`, explicit route arrays, an empty array, and invalid scalar input.

---

## A2. Introduce target and subresource policy

### Change

Add an installation-level and project-level target policy:

- allowed origin patterns;
- permitted schemes (`https`, and explicitly approved internal `http` origins only);
- optional port constraints;
- redirect-origin rules;
- subresource allow/deny policy;
- private-network policy;
- DNS rebinding resistance by validating resolved addresses at connection time where practical.

The worker must receive only a validated normalized target. Redirects outside policy must fail with a specific security finding.

### Code touchpoints

- control-plane project/configuration model
- `control-plane/app/api/runs.py`
- `control-plane/app/services/runner.py`
- `browser-worker/src/lib/config.ts`
- Playwright request/navigation hooks
- capabilities endpoint and operator UI

### Acceptance criteria

- Unapproved origins are rejected synchronously before a worker starts.
- Cross-origin redirects and subresources follow explicit policy.
- Denied requests produce no credential-bearing evidence.
- Policies are visible to operators and advertised through capabilities.

---

## A3. Evidence redaction pipeline

### Change

Create one centrally configured redaction policy used before evidence becomes retrievable.

Redact or suppress:

- authorization and cookie headers;
- API keys, bearer tokens, session identifiers, CSRF values;
- configured query-string fields;
- configured JSON/form fields;
- credential fields and login input values;
- sensitive URL fragments;
- response bodies above bounded allowlisted rules;
- customer-defined DOM selectors/regions in screenshots.

Apply redaction to console, network summaries, HAR, manifests, screenshots/contact sheets, and any future AI request bundle.

Prefer capture-time omission for secrets over post-processing. Post-processing is a second line of defense, not the only control.

### Proposed policy shape

```json
{
  "headers": ["authorization", "cookie", "set-cookie", "x-api-key"],
  "queryKeys": ["token", "code", "session"],
  "jsonKeys": ["password", "accessToken", "refreshToken"],
  "domMasks": ["[data-qa-sensitive]", ".customer-pii"],
  "bodyCapture": "allowlist",
  "maxBodyBytes": 16384
}
```

### Acceptance criteria

- Fixture secrets never appear in stored/downloaded console, HAR, manifest, screenshot, or contact-sheet artifacts.
- Redaction is deterministic and versioned in artifact metadata.
- A redaction failure can fail closed for configured sensitive projects.
- Signed artifact access cannot bypass the redacted artifact version.

---

## A4. Artifact quotas, retention, and cleanup

### Change

Implement enforceable limits at installation, project, run, and result levels:

- maximum frame count;
- maximum artifact bytes per result/run;
- maximum HAR/body size;
- artifact-type retention classes;
- project storage quota;
- cleanup of expired files and orphaned database rows/files;
- low-disk safety mode that rejects or downgrades nonessential capture before exhaustion.

Suggested retention classes:

| Artifact | Default retention behavior |
|---|---|
| Final screenshot | Retain with result |
| Contact sheet | Retain with result |
| Visual manifest | Retain with result |
| Intermediate frames | Short-lived unless result is pinned |
| Trace | Retain for failures; configurable for passes |
| Video | Failure-only; configurable |
| HAR | Reduced/redacted form retained; raw form short-lived or disabled |
| Console | Redacted structured form retained |

### Operational jobs

- cleanup command reusable from CLI and scheduler;
- recurring cleanup schedule;
- orphan reconciliation;
- quota/usage metrics;
- dry-run mode;
- auditable deletion summary without sensitive filenames or content.

### Acceptance criteria

- Expired files are physically removed and database state remains consistent.
- Cleanup is idempotent and safe against active runs.
- Quota exhaustion produces a clear status rather than corrupt/incomplete silent output.
- Operators can inspect current usage and the last cleanup outcome.

---

## A5. Correct run list and active-run UI behavior

### Change

- Enforce run list filters in the backend.
- Use deterministic ordering and pagination.
- Correct “latest run” selection.
- Poll active run detail, results, and newly ingested artifacts until terminal state.
- Stop polling on terminal state, navigation away, or component disposal.
- Guard against stale/out-of-order responses.

### Acceptance criteria

- Project/status/time filters change the returned dataset, not only the URL.
- The latest-run view selects the newest matching run.
- A live run transitions to its final state without manual reload.
- Older responses cannot overwrite newer state.

---

# Phase B — Visual Evidence v0.2.1

## B1. Define and validate the capture policy

### Change

Replace the disconnected free-form `capture: {}` behavior with a versioned schema. Normalize defaults in the control plane and pass the normalized policy to the worker.

### Proposed schema

```json
{
  "version": 1,
  "finalScreenshot": {
    "enabled": true,
    "fullPage": true,
    "format": "png"
  },
  "loadingSequence": {
    "enabled": true,
    "maxFrames": 6,
    "milestones": ["navigation", "domcontentloaded", "asserted"],
    "delaysMs": [250, 750, 1500]
  },
  "contactSheet": {
    "enabled": true,
    "format": "webp",
    "quality": 80
  },
  "trace": "on",
  "video": "retain-on-failure",
  "har": "reduced",
  "retainIntermediateFrames": false
}
```

### Rules

- Bound all arrays and numeric values.
- Reject unsupported formats or policies synchronously.
- Project defaults may be overridden only within installation limits.
- Schedules persist an immutable normalized policy snapshot for each run.
- The effective policy is returned in run detail for auditability.

### Code touchpoints

- `control-plane/app/api/runs.py`
- control-plane request/response schemas
- `control-plane/app/services/runner.py`
- `browser-worker/src/lib/config.ts`
- capabilities endpoint
- UI run/schedule configuration

### Acceptance criteria

- The worker receives the exact normalized policy stored with the run.
- Invalid or excessive policies do not queue work.
- Existing clients with omitted `capture` receive documented safe defaults.

---

## B2. Capture final screenshots for pass and fail

### Change

Capture a final full-page screenshot in guaranteed case cleanup after the final asserted state, for both successful and failed executed cases.

### Requirements

- Preserve the original assertion/error outcome if screenshot capture fails.
- Record capture failure as a separate evidence warning.
- Do not capture for cases skipped before page execution unless an explicit diagnostic policy requests it.
- Use collision-safe deterministic artifact names.
- Record browser, viewport, role, route/scenario, current URL, capture phase, dimensions, and timestamp in metadata.

### Code touchpoints

- `browser-worker/tests/fixtures.ts`
- `browser-worker/src/runner.ts`
- `browser-worker/src/lib/attachments.ts`

### Acceptance criteria

- Passing and failing cases each expose a final screenshot artifact.
- Screenshot failure does not convert a passing functional assertion into a fake functional failure; it creates an explicit evidence-degraded status/warning.
- Sensitive regions are masked before the image is persisted.

---

## B3. Capture a bounded loading sequence

### Change

Capture at deterministic milestones and bounded delays:

1. main-frame navigation committed;
2. DOM content loaded;
3. 250 ms after DOM content loaded;
4. 750 ms after DOM content loaded;
5. 1,500 ms after DOM content loaded;
6. final asserted state.

Deduplicate frames using a content hash or perceptual similarity threshold so identical images do not consume all slots.

### Safety and determinism

- Enforce `maxFrames` regardless of navigation behavior.
- Cancel timers when the case ends.
- Record missed milestones rather than waiting indefinitely.
- Do not treat network idle as a mandatory universal completion signal.
- Preserve chronological ordering independent of asynchronous write completion.

### Acceptance criteria

- A case never emits more frames than its effective policy allows.
- Frames are ordered and labelled correctly.
- A slow page demonstrates intermediate state without extending the case beyond existing timeout policy.
- Duplicate-frame suppression is deterministic and tested.

---

## B4. Generate contact sheet and visual manifest

### Change

Add `browser-worker/src/visual/contactSheet.ts` using Sharp/libvips.

The contact sheet must:

- order frames chronologically;
- fit within configured pixel and byte limits;
- label each frame with route/scenario, role, browser, viewport, elapsed time, and phase;
- use an optimized WebP output for rapid UI and Hermes inspection;
- remain readable if one or more frames are missing.

The visual manifest must include:

```json
{
  "version": 1,
  "resultId": "...",
  "capturePolicy": {},
  "redactionPolicyVersion": "...",
  "frames": [
    {
      "artifact": "...",
      "sequence": 0,
      "phase": "domcontentloaded",
      "elapsedMs": 0,
      "capturedAt": "...",
      "url": "...",
      "width": 0,
      "height": 0,
      "sha256": "..."
    }
  ],
  "finalScreenshot": "...",
  "contactSheet": "...",
  "warnings": []
}
```

### Artifact types

- `screenshot`
- `screenshot_frame`
- `contact_sheet`
- `visual_manifest`

### Acceptance criteria

- Every result with at least one visual frame has a valid manifest.
- Contact-sheet labels correspond exactly to manifest entries.
- Contact-sheet generation failure preserves individual screenshots and emits a warning.
- Manifest hashes match stored artifacts.

---

## B5. Ingest and expose visual artifacts

### Change

Extend attachment mapping and ingestion without requiring a database schema change if artifact type is already a free-form string.

Add a visual-evidence projection that returns:

- final screenshot;
- contact sheet;
- ordered frame metadata;
- signed artifact links;
- expiry and size;
- evidence warnings;
- redaction policy version.

Expose through REST first. MCP delegates to REST.

### Proposed endpoint

```text
GET /api/v1/results/{result_id}/visual-evidence
```

### Proposed MCP tool

```text
get_visual_evidence(result_id)
```

### Acceptance criteria

- Authorized users can retrieve visual metadata and signed links.
- Unauthorized or cross-project access fails consistently.
- Expired/deleted artifacts return explicit unavailable state.
- MCP output is bounded and does not inline binary content.

---

## B6. Visual evidence UI

### Change

Update case-level result rows and result detail:

- visual-evidence indicator;
- contact-sheet preview;
- final screenshot preview;
- frame timeline;
- fullscreen/open/download actions;
- capture-warning state;
- loading, unavailable, expired, and error states;
- keyboard-accessible controls and useful alt text.

### Code touchpoints

- `web-ui/src/drawers/ResultDrawer.tsx`
- `web-ui/src/components/ArtifactRow.tsx` or current equivalent
- result row/list components
- API client and types

### Acceptance criteria

- Visual evidence is available for passing and failing cases.
- Operators can distinguish “not requested,” “capture failed,” “expired,” and “available.”
- Active-run polling reveals visual evidence as it is ingested.
- UI does not download full-resolution images until requested.

---

## B7. Live production verification

Run a real authenticated FAI Chromium regression through MCP and verify:

1. run creation and policy snapshot;
2. active polling to terminal state;
3. passing-case final screenshot;
4. loading frames within bound;
5. contact sheet and manifest;
6. signed artifact retrieval;
7. redaction fixture absence;
8. result UI presentation;
9. cleanup behavior for short-lived frames;
10. no leftover schedules or test fixtures.

Repeat one representative case in Firefox and WebKit to ensure browser-independent artifact ingestion.

---

# Phase C — Route and scenario discovery

## C1. Route source model

Represent routes as reviewed records rather than only strings:

- path/template;
- source: manual, YAML, sitemap, crawl, observed navigation, generated scenario;
- first/last seen;
- authentication role;
- enabled/ignored state;
- discovery run;
- parameter policy;
- canonical route identity;
- review status.

Never automatically execute arbitrary newly discovered parameterized URLs without normalization and policy checks.

## C2. Discovery adapters

Implement bounded adapters in this order:

1. sitemap import;
2. configured route/YAML import under truthful naming;
3. authenticated same-origin crawler;
4. link and SPA history/navigation observation;
5. reviewed network-derived candidate routes.

Each adapter produces candidates. Operators or an explicit policy promote candidates into executable route definitions.

## C3. Declarative scenarios

Add a provider-agnostic scenario model for:

- navigate;
- click;
- fill/select;
- wait for visible/hidden;
- assert text/URL/element;
- capture milestone;
- extract bounded state;
- reusable login/setup state;
- tags and route associations.

Scenario execution remains deterministic and schema validated. No arbitrary JavaScript by default.

## C4. Interactive browser tools for Hermes

Expose bounded browser actions through authenticated REST/MCP for exploration sessions:

- open/navigate;
- inspect accessible tree;
- click/type/select;
- screenshot;
- read console/network summaries;
- save reviewed actions as a scenario draft.

Exploration sessions require target policy, role authorization, action limits, expiration, and complete audit logging.

## C5. Acceptance criteria

- Discovery reports new candidates without silently expanding scheduled scope.
- Same route discovered through multiple sources deduplicates to one canonical identity.
- Scenario drafts require review before scheduled execution.
- Generated scenarios are replayable without Hermes.
- Route and scenario results retain explicit associations for affected reruns.

---

# Phase D — Hermes analysis and remediation

## D1. Persistent workflow model

Add deterministic records for:

- `Finding`
- `Analysis`
- `FixProposal`
- `Approval`
- `RemediationAttempt`
- source branch/commit/PR reference
- deployment reference
- verification run
- final outcome: verified, rejected, inconclusive, superseded

Every transition records actor, timestamp, source state, target state, and reason.

## D2. Finding creation

Auto QA creates deterministic findings from:

- functional assertion failures;
- console/network failure signatures;
- evidence degradation;
- visual-baseline deltas;
- accessibility violations;
- performance-budget breaches.

Hermes may attach analysis and correlate findings, but it must not rewrite immutable raw evidence.

## D3. Analysis bundle

Create a bounded bundle containing:

- result and scenario metadata;
- deterministic failure summary;
- contact sheet and final screenshot links;
- selected loading frames;
- redacted console/network summaries;
- trace/HAR availability, not necessarily full inline content;
- related historical findings and previous verification outcomes.

## D4. Approval and implementation policy

- Hermes produces a proposal with files, rationale, risk, and verification plan.
- Auto QA stores proposal state and approval decision.
- Approved implementation occurs in an allowlisted repository and branch.
- Default output is a reviewable PR/branch.
- Direct production writes and direct `main` writes are prohibited.
- Deployment uses existing Footprints deployment workflows.
- Verification uses exact or affected reruns linked to the remediation attempt.

Initially allow only low-risk categories for semi-automated approval, such as tightly bounded CSS/layout changes. Authentication, authorization, data access, billing, infrastructure, and destructive changes always require explicit human approval.

## D5. MCP surface

Candidate tools, all backed by REST:

- `list_findings`
- `get_finding`
- `create_analysis`
- `create_fix_proposal`
- `approve_fix_proposal`
- `reject_fix_proposal`
- `record_remediation_attempt`
- `link_deployment`
- `verify_remediation`

## D6. Acceptance criteria

- A finding can be traced from raw result to analysis, proposal, approval, change, deployment, and verification run.
- No remediation can be marked verified without a terminal linked verification run.
- Failed verification reopens or rejects the remediation rather than hiding history.
- Every privileged transition is authorized and auditable.

---

# Phase E — Quality platform

## E1. Visual baselines

- Explicit baseline approval.
- Browser/viewport/role/route-specific identity.
- Perceptual diff plus masked dynamic regions.
- Baseline history and rollback.
- No automatic baseline replacement after failure.

## E2. Accessibility

Integrate axe-core with:

- deterministic rule/version recording;
- severity policy;
- allowlisted suppressions with expiry and owner;
- affected-element evidence;
- trend reporting.

## E3. Performance budgets

Capture bounded browser timing metrics and enforce project budgets for:

- navigation and paint milestones;
- route completion/assertion time;
- failed requests;
- transferred bytes/request counts where reliable;
- project-specific thresholds.

Use HAR reduction rather than retaining unlimited raw payloads.

## E4. Scheduling and operations

Complete schedule UI and add:

- worker heartbeat;
- scheduler heartbeat;
- queue/run age monitoring;
- stuck-run reconciliation;
- cleanup status;
- storage utilization;
- notification policies;
- change-aware and affected-suite execution.

## E5. Reporting

Provide project trends for:

- pass/fail/degraded evidence;
- flaky scenarios;
- new/reopened findings;
- visual/accessibility/performance regressions;
- storage and retention;
- remediation verification rate.

---

## 6. Data contracts

### 6.1 Run capture policy

Store both:

- requested policy;
- normalized effective policy.

The effective policy is immutable after queueing and carries a schema version.

### 6.2 Artifact metadata

Each artifact record should expose:

- artifact type;
- result/run/project ownership;
- MIME type;
- byte size;
- checksum;
- created and expiry timestamps;
- redaction policy version;
- retention class;
- capture phase/sequence where applicable;
- available/deleted/expired state.

### 6.3 Evidence degradation

Do not overload functional status. Track evidence state separately:

```text
complete | degraded | unavailable | not_requested
```

A functional pass with failed screenshot capture is still a functional pass, but evidence state is `degraded` and can fail a project-level evidence completeness gate if configured.

---

## 7. Security requirements

1. Project authorization must guard every result, artifact, finding, proposal, and approval operation.
2. Signed artifact URLs must be short-lived and scoped to one artifact.
3. Secrets must be omitted at capture time wherever possible.
4. Screenshot masking must happen before persistence.
5. Raw evidence must never be forwarded to Hermes without applying the effective redaction policy.
6. Target validation must occur before credentials are loaded into the browser context.
7. Exploration actions require stricter limits and complete audit logs.
8. Credential UI copy must reflect actual storage accurately; do not claim encryption when storage is only filesystem-permission protected.
9. Add secret-pattern tests against fixture evidence and candidate diffs.
10. Artifact paths must be generated server-side and protected from traversal or collision.

---

## 8. Testing strategy

### 8.1 Browser-worker unit tests

- passing case emits final screenshot;
- failing case still emits expected evidence;
- skipped case follows policy;
- bounded loading frame count;
- milestone ordering;
- timer cancellation;
- duplicate-frame suppression;
- screenshot write failure preserves assertion status;
- contact-sheet generation and labels;
- contact-sheet failure fallback;
- manifest schema and checksum correctness;
- attachment-type mapping;
- redaction/masking fixtures;
- cross-browser attachment normalization.

### 8.2 Control-plane tests

- capture policy defaults and validation;
- effective policy serialization to worker;
- installation/project limit enforcement;
- target allowlist and redirects;
- artifact ingestion and ownership;
- signed access authorization;
- visual-evidence projection;
- expiry and cleanup idempotency;
- quota behavior;
- run list filters and pagination;
- active/terminal state transitions;
- MCP thin delegation;
- finding/remediation state machine when Phase D begins.

### 8.3 UI tests

- default `["ALL"]` payload;
- capture controls and validation;
- passing/failing visual evidence;
- degraded/unavailable/expired states;
- active polling and stale-response protection;
- schedule management;
- role and project authorization behavior;
- keyboard accessibility.

### 8.4 Integration tests

- worker → ingestion → REST → signed artifact;
- REST → MCP visual evidence;
- cleanup against active and expired runs;
- redaction across console, HAR, screenshot, and manifest;
- target-policy rejection before worker spawn;
- exact rerun linked to source result.

### 8.5 Live smoke tests

- authenticated FAI Chromium run;
- representative Firefox and WebKit case;
- visual review in UI;
- Hermes retrieval and vision inspection;
- cleanup and storage verification;
- schedule lifecycle without leftover fixtures.

---

## 9. Rollout plan

### 9.1 Feature flags

Introduce independent controls:

- `visualEvidenceV1`
- `loadingSequence`
- `contactSheet`
- `evidenceRedactionV1`
- `artifactCleanup`
- `targetPolicyEnforcement`

Enable in a test project first, then the FAI project, then make safe defaults installation-wide.

### 9.2 Compatibility

- Omitted capture policy maps to versioned defaults.
- Existing results remain readable without visual evidence.
- UI handles legacy results with no manifest.
- MCP tool additions are additive.
- Artifact-type strings remain backward compatible.

### 9.3 Rollback

- Disable visual capture flags without rolling back run correctness/security fixes.
- Keep schema migrations backward compatible until rollout is accepted.
- Preserve individual screenshots if compositor rollout is disabled.
- Do not disable redaction or target policy as a performance workaround.

### 9.4 Observability gates

Before broader enablement, measure:

- artifact bytes per case/run;
- worker duration delta;
- compositor failures;
- evidence-degraded rate;
- cleanup reclaimed bytes and failures;
- signed-artifact errors;
- UI load behavior;
- redaction test failures.

No performance claim is accepted without measured before/after run evidence.

---

## 10. Documentation updates

Update documentation in the same release as behavior:

- REST request/response contracts;
- effective capture policy and limits;
- artifact types and retention;
- target and redaction policy;
- schedule/operator procedures;
- MCP tool inventory generated from live registration where possible;
- truthful distinction between route import, discovery, and exploration;
- credential storage behavior;
- evidence security guidance;
- failure and rollback procedures.

The README must not retain the stale “12 MCP tools” statement after the deployed service exposes 23 or more tools.

---

## 11. Delivery sequence and hard gates

| Order | Deliverable | Hard gate before continuing |
|---:|---|---|
| 1 | UI `ALL` fix, backend list/filter correctness | API/UI tests and live default-run smoke pass |
| 2 | Target policy | Unapproved origins rejected before worker spawn |
| 3 | Redaction foundation | Secret fixtures absent from every retrievable artifact class |
| 4 | Quotas, retention, cleanup | Idempotent cleanup and low-disk/quota tests pass |
| 5 | Capture policy plumbing | Stored effective policy equals worker policy |
| 6 | Final pass/fail screenshots | Live passing FAI case exposes redacted screenshot |
| 7 | Loading frames, manifest, contact sheet | Bounded sequence, valid checksums, fallback tested |
| 8 | REST/UI/MCP visual evidence | End-to-end authorized retrieval and UI review pass |
| 9 | Route/scenario discovery | Candidates cannot silently enter schedules |
| 10 | Hermes findings/remediation | Full auditable proposal-to-verification chain works |
| 11 | Baselines/accessibility/performance/operations | Each capability has explicit policy, evidence, and rollback |

---

## 12. Definition of done for Phase A + B

Phase A + B are complete only when all statements below are true:

- [ ] Default UI runs send `routes: ["ALL"]` and execute successfully.
- [ ] Run filters, latest-run selection, and active polling work against the backend contract.
- [ ] Unapproved targets cannot start a worker.
- [ ] Evidence redaction is versioned and verified across console, network/HAR, screenshots, contact sheets, and manifests.
- [ ] Artifact quotas and physical expiry cleanup are running and observable.
- [ ] Capture policy is schema validated, normalized, persisted, and passed to the worker.
- [ ] Every executed passing and failing case produces a final screenshot unless policy explicitly disables it.
- [ ] Loading frames are bounded, ordered, deduplicated, and labelled.
- [ ] Contact sheets and visual manifests are generated with correct relationships and checksums.
- [ ] Evidence degradation is separate from functional result status.
- [ ] Visual evidence is accessible through authorized REST, UI, and MCP flows.
- [ ] A live authenticated FAI Chromium regression proves the complete path.
- [ ] Representative Firefox and WebKit cases prove browser-independent ingestion.
- [ ] No fixture schedules, credentials, or temporary test artifacts remain after verification.
- [ ] Focused tests, complete backend tests, worker tests, UI build/type checks, and live smoke tests pass.
- [ ] Documentation matches the deployed contracts and actual MCP inventory.

---

## 13. Immediate implementation backlog

### Release slice 1 — Safety and correctness

- [ ] Fix the UI `["ALL"]` request.
- [ ] Implement backend run filters/order/pagination.
- [ ] Repair active-run polling and stale-response handling.
- [ ] Add target policy and synchronous validation.
- [ ] Add evidence redaction configuration and fixture suite.
- [ ] Add storage accounting, quotas, expiry cleanup, and dry-run reconciliation.
- [ ] Correct credential-storage and route-discovery wording.

### Release slice 2 — Visual Evidence v0.2.1

- [ ] Define capture policy schemas and capabilities.
- [ ] Pass effective policy from control plane to worker.
- [ ] Capture pass/fail final screenshots.
- [ ] Capture bounded loading frames.
- [ ] Add screenshot masking and metadata.
- [ ] Generate visual manifest.
- [ ] Generate contact sheet using Sharp/libvips.
- [ ] Extend artifact mapping and ingestion.
- [ ] Add visual-evidence REST endpoint and MCP tool.
- [ ] Add result-row indicator, preview, timeline, and fullscreen UI.
- [ ] Execute live FAI and cross-browser verification.

### Release slice 3 — Discovery and scenarios

- [ ] Add route candidate model and review workflow.
- [ ] Implement sitemap and bounded authenticated crawler adapters.
- [ ] Add SPA navigation observation.
- [ ] Add declarative scenario schema and replay.
- [ ] Add bounded interactive exploration tools.
- [ ] Add Hermes exploration-to-reviewed-scenario workflow.

### Release slice 4 — Analysis and remediation

- [ ] Add finding/analysis/proposal/approval/remediation records.
- [ ] Add state transitions and audit events.
- [ ] Add bounded analysis bundle.
- [ ] Add REST/MCP workflow tools.
- [ ] Integrate branch/PR implementation and deployment references.
- [ ] Link exact/affected verification runs and outcomes.

### Release slice 5 — Quality platform

- [ ] Add reviewed visual baselines.
- [ ] Add axe-core accessibility policy.
- [ ] Add performance budgets.
- [ ] Complete schedule UI and health monitoring.
- [ ] Add notifications, trends, and storage dashboards.

---

## 14. Final recommendation

Start implementation with **Phase A and Phase B as one controlled program**, but preserve separate feature flags so visual capture can be rolled back independently of correctness and security controls.

The first externally visible milestone should not be “screenshots enabled.” It should be:

> A live authenticated FAI run produces bounded, redacted, retained visual evidence for passing and failing cases; operators and Hermes can retrieve it through supported interfaces; storage and target policies are enforced; and the result is backed by automated and live verification.
