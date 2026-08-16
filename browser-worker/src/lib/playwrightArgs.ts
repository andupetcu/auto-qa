/** @fileoverview Deterministic Playwright matrix and isolated flake-rerun arguments. */
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

// Isolated flake reruns reuse the authenticated storage state created by the matrix run.
// `--no-deps` prevents replaying expensive authentication before every attempt.
export function buildFlakeRerunArgs(role: string, testTitle: string): string[] {
  const args = [...CONFIG_ARGS, '--project', role, '--no-deps'];
  args.push('--grep', titleGrepPattern(testTitle), '--workers', '1');
  return args;
}
