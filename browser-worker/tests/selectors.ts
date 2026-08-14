// Selector contract with the app under test. All values are env-overridable so the
// Hermes layer (or an operator) can supply its own per run — nothing here is load-bearing
// beyond the dev defaults probed against the app under test (2026-08-14).
// Resolution precedence (see tests/projectConfig.ts): QA_RUN_SELECTORS JSON (per-project,
// set by the control plane) > individual QA_SEL_*/QA_LOGIN_PATH/QA_GATE_TEXT env vars >
// the probed defaults below.
import { resolveSelectors } from './projectConfig';

export const SEL = resolveSelectors(process.env);
