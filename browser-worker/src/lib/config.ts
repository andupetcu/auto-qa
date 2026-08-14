import path from 'node:path';

export interface HarConfig {
  bodyBytes: number;
  topN: number;
  slowMs: number;
}

export interface ConsoleConfig {
  topN: number;
}

export interface RunnerConfig {
  runId: string;
  cpUrl: string;
  apiToken: string;
  baseUrl?: string;
  routes: string[] | null;
  roles: string[];
  browser: 'chromium' | 'firefox' | 'webkit';
  viewport: { width: number; height: number };
  viewportLabel: string;
  artifactsDir: string;
  flakeReruns: number;
  harConfig: HarConfig;
  consoleConfig: ConsoleConfig;
}

function parseSingleSelector(
  raw: string | undefined,
  label: 'browser' | 'viewport',
  fallback: string,
): string {
  if (!raw) return fallback;
  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error(`QA_RUN_${label.toUpperCase()}S must be a JSON array`);
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error(`QA_RUN_${label.toUpperCase()}S must be a JSON array of strings`);
  }
  if (values.length === 0) return fallback;
  if (values.length !== 1) {
    throw new Error(`worker subprocess requires exactly one ${label}`);
  }
  return values[0];
}

function resolveExecution(env: NodeJS.ProcessEnv): {
  browser: RunnerConfig['browser'];
  viewport: RunnerConfig['viewport'];
  viewportLabel: string;
} {
  const browser = parseSingleSelector(env.QA_RUN_BROWSERS, 'browser', 'chromium');
  if (!['chromium', 'firefox', 'webkit'].includes(browser)) {
    throw new Error(`unsupported browser: ${browser}`);
  }
  const viewportLabel = parseSingleSelector(
    env.QA_RUN_VIEWPORTS,
    'viewport',
    '1440x900',
  );
  const match = viewportLabel.match(/^(\d+)x(\d+)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    throw new Error(`invalid viewport: ${viewportLabel}`);
  }
  return {
    browser: browser as RunnerConfig['browser'],
    viewport: { width: Number(match[1]), height: Number(match[2]) },
    viewportLabel,
  };
}

// Reads and validates the env contract documented in the v0.2 plan. Pure aside from the
// `cwd` default: pass an explicit cwd in tests to avoid depending on process.cwd().
export function loadConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): RunnerConfig {
  const runId = env.QA_RUN_ID;
  if (!runId) throw new Error('QA_RUN_ID is required');

  const apiToken = env.QA_API_TOKEN;
  if (!apiToken) throw new Error('QA_API_TOKEN is required');

  const cpUrl = env.QA_CP_URL ?? 'http://127.0.0.1:8787/api/v1';
  const baseUrl = env.QA_RUN_BASE_URL ?? env.QA_BASE_URL_DEFAULT;
  const routes = env.QA_RUN_ROUTES ? (JSON.parse(env.QA_RUN_ROUTES) as string[]) : null;
  const roles = env.QA_RUN_ROLES ? (JSON.parse(env.QA_RUN_ROLES) as string[]) : ['user', 'anon'];
  const execution = resolveExecution(env);
  const artifactsDir = env.QA_ARTIFACTS_DIR ?? path.resolve(cwd, '../var/artifacts');
  const flakeReruns = Number(env.QA_FLAKE_RERUNS ?? 3);

  const harConfig: HarConfig = {
    bodyBytes: Number(env.QA_HAR_BODY_BYTES ?? 512),
    topN: Number(env.QA_HAR_TOP_N ?? 10),
    slowMs: Number(env.QA_SLOW_REQUEST_MS ?? 3000),
  };
  const consoleConfig: ConsoleConfig = {
    topN: Number(env.QA_CONSOLE_TOP_N ?? 20),
  };

  return {
    runId,
    cpUrl,
    apiToken,
    baseUrl,
    routes,
    roles,
    ...execution,
    artifactsDir,
    flakeReruns,
    harConfig,
    consoleConfig,
  };
}
