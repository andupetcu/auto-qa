import type { RunnerConfig } from './config';

export interface ArtifactEntry {
  type: string;
  storage_key: string;
  bytes: number | null;
}

export interface FailedAction {
  step: null;
  error: string | null;
  actual: null;
}

export interface BuildResultIngestInput {
  test_name: string;
  test_file: string;
  route_path: string | null;
  role: string;
  status: string;
  duration_ms: number;
  flaky: boolean;
  reruns_attempted: number;
  reruns_failed: number;
  failed_action: FailedAction | null;
  shell_rendered: boolean | null;
  console_summary: unknown[];
  network_summary: unknown[];
  dom_excerpt: string | null;
  signature_input: Record<string, unknown> | null;
  artifacts: ArtifactEntry[];
}

// Field set matches control-plane's ResultIngest exactly (see control-plane/tests/conftest.py
// result_payload / control-plane/app/api/results.py ResultIngest).
export interface ResultIngest extends BuildResultIngestInput {
  browser: string;
  viewport: string;
}

export function buildResultIngest(input: BuildResultIngestInput): ResultIngest {
  return {
    ...input,
    browser: 'chromium',
    viewport: '1440x900',
  };
}

export function buildFailedAction(errorMessage: string | null): FailedAction {
  return { step: null, error: errorMessage, actual: null };
}

// The `setup` project only authenticates roles; it produces no matrix results to ingest.
export function isIngestableProject(projectName: string): boolean {
  return projectName !== 'setup';
}

interface ErrorLikeConsoleEntry {
  level: string;
  text: string;
  raw_source?: string | null;
}

export function pickFirstErrorEntry<T extends ErrorLikeConsoleEntry>(entries: T[]): T | undefined {
  return entries.find((e) => e.level === 'error');
}

export function resolveSignatureError(errorMessage: string | null, firstConsoleErrorText: string | undefined): string {
  return errorMessage ?? firstConsoleErrorText ?? 'unknown';
}

export function resolveTopFrame(
  resolved: string | null | undefined,
  rawSource: string | null | undefined,
): string {
  return resolved ?? rawSource ?? '';
}

// --- HTTP glue (integration code, exercised by the live E2E smoke, not unit tests) ---

function authHeaders(cfg: RunnerConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.apiToken}`,
    'Content-Type': 'application/json',
  };
}

export async function postStarted(cfg: RunnerConfig): Promise<void> {
  const res = await fetch(`${cfg.cpUrl}/internal/runs/${cfg.runId}/started`, {
    method: 'POST',
    headers: authHeaders(cfg),
  });
  if (!res.ok) {
    throw new Error(`POST started failed: ${res.status} ${await res.text()}`);
  }
}

export async function postResults(cfg: RunnerConfig, results: ResultIngest[]): Promise<void> {
  if (results.length === 0) return;
  const res = await fetch(`${cfg.cpUrl}/internal/runs/${cfg.runId}/results`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify(results),
  });
  if (!res.ok) {
    throw new Error(`POST results failed: ${res.status} ${await res.text()}`);
  }
}

export async function postFinalize(
  cfg: RunnerConfig,
  status: 'completed' | 'failed' | 'auth_expired',
  detail?: string,
): Promise<{ status: string; totals: unknown }> {
  const res = await fetch(`${cfg.cpUrl}/internal/runs/${cfg.runId}/finalize`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify(detail ? { status, detail } : { status }),
  });
  if (!res.ok) {
    throw new Error(`POST finalize failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
