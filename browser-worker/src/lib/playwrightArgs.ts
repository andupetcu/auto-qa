import { titleGrepPattern } from './flake';

const CONFIG_ARGS = ['test', '--config', 'tests/playwright.config.ts'];

// Full matrix run: `setup` is only needed to authenticate non-anon roles.
export function buildMatrixArgs(roles: string[]): string[] {
  const needsSetup = roles.some((r) => r !== 'anon');
  const projects = needsSetup ? ['setup', ...roles] : [...roles];

  const args = [...CONFIG_ARGS];
  for (const p of projects) args.push('--project', p);
  return args;
}

// Isolated single-test flake rerun: one role only, workers=1, no parallelism.
export function buildFlakeRerunArgs(role: string, testTitle: string): string[] {
  const projects = role === 'anon' ? [role] : ['setup', role];

  const args = [...CONFIG_ARGS];
  for (const p of projects) args.push('--project', p);
  args.push('--grep', titleGrepPattern(testTitle), '--workers', '1');
  return args;
}
