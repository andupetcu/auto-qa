import { describe, expect, test } from 'vitest';
import { setupFailed } from '../src/lib/flake';

// role === 'setup' is the auth.setup.ts project; if it fails (e.g. missing/invalid
// credentials for a project) the run must be reported failed, not falsely "completed"
// off skipped dependents.
describe('setupFailed', () => {
  test('true when the setup project failed', () => {
    expect(setupFailed([
      { role: 'setup', status: 'failed' },
      { role: 'user', status: 'skipped' },
    ])).toBe(true);
  });

  test('true when the setup project timed out', () => {
    expect(setupFailed([{ role: 'setup', status: 'timed_out' }])).toBe(true);
  });

  test('false when setup passed', () => {
    expect(setupFailed([
      { role: 'setup', status: 'passed' },
      { role: 'user', status: 'passed' },
    ])).toBe(false);
  });

  test('false when there is no setup project (anon-only run)', () => {
    expect(setupFailed([{ role: 'anon', status: 'passed' }])).toBe(false);
  });
});
