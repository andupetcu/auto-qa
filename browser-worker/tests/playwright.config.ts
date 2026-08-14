import { defineConfig } from '@playwright/test';
import { resolveRoles, sessionStatePath } from './projectConfig';

const roles = resolveRoles(process.env).map(r => r.name);

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  workers: Number(process.env.QA_PW_WORKERS ?? 4),
  retries: 0, // NEVER set retries; flake discrimination is the runner's job (doc 06 §5)
  timeout: 45_000,
  outputDir: process.env.QA_PW_OUTPUT_DIR ?? 'test-results',
  reporter: [
    ['json', { outputFile: process.env.QA_PW_REPORT ?? 'test-results/report.json' }],
    ['line'],
  ],
  use: {
    baseURL: process.env.QA_RUN_BASE_URL ?? process.env.QA_BASE_URL_DEFAULT,
    trace: 'on', // traces for passing runs too (arch §3.3)
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    ...roles.filter(r => r !== 'anon').map(r => ({
      name: r,
      dependencies: ['setup'],
      use: { storageState: sessionStatePath(process.env, r) },
    })),
    ...(roles.includes('anon') ? [{ name: 'anon', use: {} }] : []),
  ],
});
