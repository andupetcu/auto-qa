# Auto QA Safe Visual Evidence — Exhaustive QA Plan

## Objective

Prove that visual evidence is useful, bounded, deterministic, secret-safe, integrity-checked, quota-controlled, authorized, retainable, and correctly rendered through the complete deployed path. A rendered page or HTTP 200 alone is not a pass.

## Release gates

1. Every automated suite passes on the exact staged revision.
2. Adversarial tests prove rejection occurs before result/artifact persistence.
3. A real deployed run produces accepted result rows and retrievable visual evidence.
4. Signed links expose only sanitized artifacts and fail when missing, malformed, tampered, or expired.
5. Capture errors never alter the underlying test verdict.
6. PM2 is online after restart, startup logs are clean, Git whitespace checks pass, and no unstaged files remain.

## Scenario matrix

### A. Capture-policy contract

- Defaults normalize identically in control plane and worker.
- Explicit minimum and maximum legal values are accepted.
- Below-minimum, above-maximum, wrong-type, unknown-version, malformed JSON, and excessive selector/delay arrays are rejected.
- Mask selectors are trimmed/deduplicated and mandatory defaults cannot be removed.
- Reruns inherit the immutable snapshot.
- Worker rejects missing, malformed, unsupported, and out-of-bounds snapshots rather than silently using divergent defaults.

### B. Secret-safe pixel capture

- Password, `autocomplete=current-password`, and `[data-sensitive=true]` regions are black before bytes are written.
- Project selectors are also masked.
- Multiple and overlapping masks work.
- Missing/invalid selectors fail soft with bounded warnings.
- No raw unmasked screenshot is attached, persisted, signed, or left as a retrievable variant.

### C. Bounded frames/video

- Milestones remain ordered: navigation, DOM-ready, configured delays, asserted state.
- Exact duplicate frames are SHA-256 deduplicated.
- Frame and delay maxima are enforced.
- Intermediate frames are absent when retention is disabled and signed when enabled.
- Final asserted state remains independently available.
- Video/trace/HAR retention follows policy.
- Timer, screenshot, compositor, and video-finalization failures add warnings but preserve verdict.

### D. Contact sheets

- Real WebP output has valid dimensions and decodes.
- Labels include route, role, browser, viewport, milestone, and timestamp.
- Ordering is deterministic.
- Pixel and byte ceilings hold at legal extremes.
- Quality reduction/resizing is deterministic.
- Empty/single/multiple/deduplicated frame inputs behave safely.
- Compositor failure preserves final screenshot and emits a warning.

### E. Manifest and transport integrity

- Schema and capture-policy versions are present.
- Server binds the generated result ID.
- Frame order, dimensions, actual bytes, and SHA-256 values match persisted files.
- Capture-time filenames are rebound to Playwright transport filenames by hash and bytes.
- Missing, ambiguous, hash-mismatched, byte-mismatched, duplicate, traversal, and foreign-run references are rejected.
- Rejection creates neither result rows nor artifact rows.
- Metadata-only timeline frames have no dead signed links.

### F. Redaction and artifact security

- Structured evidence, console, HAR headers/query/body, trace text, credentials, cookies, bearer tokens, sessions, passwords, and API keys are redacted synchronously.
- Artifact paths cannot escape the owning run directory through `..`, absolute paths, symlinks, or prefix collisions.
- Files must exist and actual filesystem size is authoritative.
- Artifact projection reports `evidence-redaction-v1`, `state=redacted`, and `raw_variant_retrievable=false`.
- Raw variants cannot be selected through API parameters or signed URLs.

### G. Quotas and storage pressure

- Per-result count and bytes, per-run bytes, project storage, and free-disk reserve boundaries are tested at below/equal/above limit.
- Worker-supplied understated sizes cannot bypass enforcement.
- Violations return the documented `413`/`507` problem response and finalize the run failed rather than leaving it active.
- Partial ingestion is atomic.

### H. API authorization and signing

- Visual endpoint distinguishes `captured` and `not_captured`.
- Missing/invalid bearer token returns `401`.
- Existing result in another project cannot be accessed outside authorization scope.
- Signed screenshot, sheet, retained-frame, manifest, HAR, console, and trace links return the expected content.
- Invalid signature, tampered path/query, missing signature, and expiration fail closed.
- Signed links intentionally omit `/api/v1`.

### I. Run lifecycle

- New run, full rerun, failed-case rerun, cancellation, progress, finalization, and empty-result states remain correct.
- Capture-policy snapshot survives rerun.
- Post-processing failure produces a terminal failed run with no corrupt partial rows.
- Successful live run creates all expected results once, with no duplicates.

### J. Retention and reconciliation

- Dry-run never mutates storage.
- Expired rows/files, missing-file rows, orphans, sidecars, and empty directories reconcile deterministically.
- Queued/running run directories are protected.
- Repeated reconciliation is idempotent.
- Signed access fails after eligible deletion.

### K. UI/runtime

- Runs, Projects, Coverage, New Run, run details, result drawer, and bundle drawer load after deployment.
- Contact sheet, timeline, final masked image, warnings, artifacts, and legacy fallback render correctly.
- `not_captured`, metadata-only frame, warning, skipped, failed, and legacy-result states are understandable and contain no broken images/links.
- Keyboard close/focus, narrow viewport, loading, and API-error states are exercised.
- Fresh console and network buffers have no unexpected failures after each changed interaction.

### L. Regression and operations

- Full control-plane pytest suite.
- Full worker Vitest suite, TypeScript check, and production dependency audit.
- Web UI TypeScript/lint and production build.
- Git staged/unstaged whitespace checks.
- PM2 restart, HTTP smoke, clean startup logs, real run, API/UI evidence inspection.

## Evidence and verdict rules

Each scenario is recorded as PASS, FAIL, BLOCKED, or NOT APPLICABLE with concrete output. Any security/integrity failure blocks release. Existing expected authorization failures are not console/runtime defects when intentionally induced. Residual risks and scenarios requiring destructive production mutation are reported separately rather than simulated with fabricated results.
