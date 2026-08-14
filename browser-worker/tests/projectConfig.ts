// Pure project-config resolution for the Playwright test layer (v0.2 "projects").
// No side effects, no filesystem/env mutation — every function takes an env record (or
// equivalent) as input and returns a plain value. Consumed by playwright.config.ts,
// selectors.ts, auth.setup.ts and matrix.spec.ts, and covered directly by
// unit/projectConfig.test.ts.

export type Env = Record<string, string | undefined>;

export interface Selectors {
  loginPath: string;
  loginEmail: string;
  loginPassword: string;
  loginSubmitName: string;
  appShell: string;
  gateText: string;
}

export interface Role {
  name: string;
  credential_ref?: string;
}

export type Matrix = Record<string, Record<string, unknown>>;

// Probed defaults against https://fai.footprints.media (2026-08-14) — see tests/selectors.ts.
const DEFAULT_SELECTORS: Selectors = {
  loginPath: '/?auth=login',
  loginEmail: 'input[name=username]',
  loginPassword: 'input[name=password]',
  loginSubmitName: 'Login',
  appShell: 'main, [data-testid=submenu-container]',
  gateText: 'Log in to continue',
};

const SELECTOR_ENV_KEYS: Record<keyof Selectors, string> = {
  loginPath: 'QA_LOGIN_PATH',
  loginEmail: 'QA_SEL_LOGIN_EMAIL',
  loginPassword: 'QA_SEL_LOGIN_PASSWORD',
  loginSubmitName: 'QA_SEL_LOGIN_SUBMIT',
  appShell: 'QA_SEL_APP_SHELL',
  gateText: 'QA_GATE_TEXT',
};

function tryParseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Precedence per key: QA_RUN_SELECTORS JSON > individual QA_SEL_*/QA_LOGIN_PATH/QA_GATE_TEXT
// env vars > probed defaults. Malformed QA_RUN_SELECTORS is ignored silently.
export function resolveSelectors(env: Env): Selectors {
  const fromRunSelectors = tryParseJson(env.QA_RUN_SELECTORS);
  const overrides = isPlainObject(fromRunSelectors) ? fromRunSelectors : {};

  const result = {} as Selectors;
  for (const key of Object.keys(DEFAULT_SELECTORS) as (keyof Selectors)[]) {
    const runValue = overrides[key];
    if (typeof runValue === 'string') {
      result[key] = runValue;
      continue;
    }
    const envValue = env[SELECTOR_ENV_KEYS[key]];
    result[key] = envValue ?? DEFAULT_SELECTORS[key];
  }
  return result;
}

// QA_RUN_ROLES_CONFIG JSON wins outright; else derived from QA_ROLES (default
// "user,anon"), with a QA_CRED_<ROLE> credential_ref for every non-anon role and none
// for anon.
export function resolveRoles(env: Env): Role[] {
  const fromRunRolesConfig = tryParseJson(env.QA_RUN_ROLES_CONFIG);
  if (Array.isArray(fromRunRolesConfig)) {
    return fromRunRolesConfig as Role[];
  }

  const names = (env.QA_ROLES ?? 'user,anon').split(',').map((r) => r.trim()).filter(Boolean);
  return names.map((name) =>
    name === 'anon' ? { name } : { name, credential_ref: `QA_CRED_${name.toUpperCase()}` },
  );
}

// QA_RUN_ROLE_MATRIX JSON wins when present and a non-empty object; else the fallback
// (role-matrix.yaml) loader's result.
export function resolveMatrix(env: Env, loadYamlFallback: () => Matrix): Matrix {
  const fromRunRoleMatrix = tryParseJson(env.QA_RUN_ROLE_MATRIX);
  if (isPlainObject(fromRunRoleMatrix) && Object.keys(fromRunRoleMatrix).length > 0) {
    return fromRunRoleMatrix as Matrix;
  }
  return loadYamlFallback();
}

export function sessionStatePath(env: Env, role: string): string {
  const project = env.QA_RUN_PROJECT ?? 'fai';
  return `.auth/${project}/${role}.json`;
}
