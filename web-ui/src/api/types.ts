// Types mirroring the Footprints QA control-plane API contract (/api/v1/*).
// Kept hand-written and in lockstep with docs/plans/web-ui-build.md + doc 02.

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'auth_expired'
  | 'canceled';

export type ResultStatus = 'passed' | 'failed' | 'skipped' | 'timed_out';

export type ExpectationValue = 'render' | 'redirect' | 'forbidden';

export type Severity = 'low' | 'medium' | 'high';

export type ArtifactType =
  | 'trace'
  | 'har'
  | 'video'
  | 'frames'
  | 'sheet'
  | 'screenshot'
  | 'console';

export interface ProblemDetails {
  title: string;
  status: number;
  detail: string;
  [key: string]: unknown;
}

export interface Capabilities {
  version: string;
  roles: string[];
  projects: string[];
  artifact_types: string[];
  browsers: string[];
  viewports: string[];
}

export interface ProjectRole {
  name: string;
  credential_ref?: string | null;
}

export interface ProjectCredentialsSummary {
  username: string | null;
  has_password: boolean;
  has_totp: boolean;
}

export interface Project {
  id: string;
  name: string;
  base_url_default: string;
  roles: ProjectRole[];
  selectors: Record<string, unknown>;
  role_matrix: Record<string, Record<string, ExpectationValue>>;
  routes_count: number;
  created_at: string;
  enabled: boolean;
  max_parallel: number;
  schedule_cron: string | null;
  next_run_at: string | null;
  credentials: ProjectCredentialsSummary;
}

export interface ProjectCreateInput {
  name: string;
  base_url_default: string;
  roles?: ProjectRole[];
  selectors?: Record<string, unknown>;
  role_matrix?: Record<string, Record<string, ExpectationValue>>;
  routes?: string[];
  schedule_cron?: string | null;
  max_parallel?: number;
  enabled?: boolean;
}

export type ProjectPatchInput = Partial<ProjectCreateInput>;

export interface ProjectCredentialsInput {
  username: string;
  password: string;
  totp_seed?: string;
}

export interface Route {
  id: string;
  base_url: string;
  path: string;
  discovery_source: string;
  first_seen: string;
  last_seen: string;
}

export interface MatrixRow {
  path: string;
  source: string;
  expectations: Record<string, ExpectationValue>;
  actuals: Record<string, ResultStatus | null>;
}

export interface RunTotals {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
}

export interface RunProgress {
  phase: string;
  done?: number;
  total?: number;
  current?: string | null;
  updated_at?: string;
}

export interface Run {
  id: string;
  project: string;
  trigger: string;
  base_url: string;
  app_version: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  totals: RunTotals | null;
  parent_run_id: string | null;
  progress: RunProgress | null;
}

export interface RunCreateInput {
  routes: string[] | 'ALL';
  project?: string;
  roles?: string[];
  browsers?: string[];
  viewports?: string[];
  base_url?: string;
  app_version?: string;
  capture?: Record<string, unknown>;
}

export interface RunCreateResponse {
  run_id: string;
  status: RunStatus;
}

export interface RerunInput {
  scope: 'failed' | 'full';
  base_url?: string;
}

export interface TestResult {
  id: string;
  test_name: string;
  test_file: string;
  route_path: string;
  role: string;
  browser: string;
  viewport: string;
  status: ResultStatus;
  duration_ms: number;
  flaky: boolean;
  reruns_attempted: number;
  reruns_failed: number;
}

export interface AffectedRoute {
  route: string;
  role: string;
}

export interface FailedAction {
  step: string;
  error: string;
  actual: string | null;
}

export interface ConsoleEntry {
  level: string;
  kind: string;
  text: string;
  source: string;
  raw_source: string | null;
  stack: string | null;
  count: number;
}

export interface NetworkFailure {
  method: string;
  url_path: string;
  status: number;
  timing_ms: number;
  resp_snippet: string;
}

export interface SignedArtifact {
  type: ArtifactType;
  url: string;
  bytes: number;
  expires_at: string;
}

export interface FailureBundleTest {
  name: string;
  file: string;
  status: ResultStatus;
  duration_ms: number;
  flaky: boolean;
  reruns_attempted: number;
  reruns_failed: number;
}

export interface FailureBundleApp {
  project: string;
  base_url: string;
  version: string | null;
}

export interface FailureBundle {
  bundle_id: string;
  run_id: string;
  cluster_id: string;
  occurrences: number;
  severity: Severity;
  affected: AffectedRoute[];
  test: FailureBundleTest;
  failed_action: FailedAction | null;
  console_errors: ConsoleEntry[];
  network_failures: NetworkFailure[];
  dom_excerpt: string;
  app: FailureBundleApp;
  artifacts: Partial<Record<ArtifactType, string>>;
  artifact_expiry: string;
}

// GET /results/{id}/har?failures_only=false shape (signed, non-array)
export interface FullHarArtifact {
  type: ArtifactType;
  url: string;
  bytes: number;
  expires_at: string;
}
