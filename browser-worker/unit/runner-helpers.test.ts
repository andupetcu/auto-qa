import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/lib/config';
import { slugify, resultKey } from '../src/lib/slug';
import { mapAttachmentType, attachmentKey, collectAttachments } from '../src/lib/attachments';
import {
  isFailureStatus,
  hasAnyFailures,
  isFlaky,
  escapeRegExp,
  titleGrepPattern,
} from '../src/lib/flake';
import { buildMatrixArgs, buildFlakeRerunArgs } from '../src/lib/playwrightArgs';
import {
  buildFailedAction,
  isIngestableProject,
  buildResultIngest,
  pickFirstErrorEntry,
  resolveSignatureError,
  resolveTopFrame,
} from '../src/lib/ingest';
import { findAuthExpiredFile } from '../src/lib/authExpired';

describe('config: loadConfig', () => {
  const REQUIRED = { QA_RUN_ID: 'run_abc', QA_API_TOKEN: 'tok123' };

  test('throws when QA_RUN_ID is missing', () => {
    expect(() => loadConfig({ QA_API_TOKEN: 'tok123' } as any)).toThrow(/QA_RUN_ID/);
  });

  test('throws when QA_API_TOKEN is missing', () => {
    expect(() => loadConfig({ QA_RUN_ID: 'run_abc' } as any)).toThrow(/QA_API_TOKEN/);
  });

  test('applies defaults when optional env vars are absent', () => {
    const cfg = loadConfig(REQUIRED as any, '/work/browser-worker');
    expect(cfg.runId).toBe('run_abc');
    expect(cfg.apiToken).toBe('tok123');
    expect(cfg.cpUrl).toBe('http://127.0.0.1:8787/api/v1');
    expect(cfg.baseUrl).toBeUndefined();
    expect(cfg.routes).toBeNull();
    expect(cfg.roles).toEqual(['user', 'anon']);
    expect(cfg.artifactsDir).toBe(path.resolve('/work/browser-worker', '../var/artifacts'));
    expect(cfg.flakeReruns).toBe(3);
    expect(cfg.harConfig).toEqual({ bodyBytes: 512, topN: 10, slowMs: 3000 });
    expect(cfg.consoleConfig).toEqual({ topN: 20 });
  });

  test('parses overrides from env', () => {
    const cfg = loadConfig({
      ...REQUIRED,
      QA_CP_URL: 'http://cp.local/api/v1',
      QA_RUN_BASE_URL: 'https://run.example',
      QA_BASE_URL_DEFAULT: 'https://default.example',
      QA_RUN_ROUTES: '["ALL"]',
      QA_RUN_ROLES: '["user"]',
      QA_ARTIFACTS_DIR: '/tmp/artifacts',
      QA_FLAKE_RERUNS: '5',
      QA_HAR_BODY_BYTES: '1024',
      QA_HAR_TOP_N: '20',
      QA_SLOW_REQUEST_MS: '5000',
      QA_CONSOLE_TOP_N: '30',
    } as any, '/work/browser-worker');
    expect(cfg.cpUrl).toBe('http://cp.local/api/v1');
    expect(cfg.baseUrl).toBe('https://run.example');
    expect(cfg.routes).toEqual(['ALL']);
    expect(cfg.roles).toEqual(['user']);
    expect(cfg.artifactsDir).toBe('/tmp/artifacts');
    expect(cfg.flakeReruns).toBe(5);
    expect(cfg.harConfig).toEqual({ bodyBytes: 1024, topN: 20, slowMs: 5000 });
    expect(cfg.consoleConfig).toEqual({ topN: 30 });
  });

  test('QA_RUN_BASE_URL falls back to QA_BASE_URL_DEFAULT', () => {
    const cfg = loadConfig({
      ...REQUIRED,
      QA_BASE_URL_DEFAULT: 'https://default.example',
    } as any, '/work/browser-worker');
    expect(cfg.baseUrl).toBe('https://default.example');
  });
});

describe('slug: slugify / resultKey', () => {
  test('lowercases, replaces non-alnum runs with a single dash, trims edges', () => {
    expect(slugify('Hello, World!!')).toBe('hello-world');
    expect(slugify('  leading and trailing  ')).toBe('leading-and-trailing');
  });

  test('truncates to maxLen without trailing dash', () => {
    const long = 'a'.repeat(80);
    expect(slugify(long, 60)).toHaveLength(60);
    const withDashNearCut = 'a'.repeat(59) + '-' + 'b'.repeat(10);
    const result = slugify(withDashNearCut, 60);
    expect(result.endsWith('-')).toBe(false);
  });

  test('resultKey combines role and test name deterministically', () => {
    const k1 = resultKey('user', 'matrix / as user -> render');
    const k2 = resultKey('user', 'matrix / as user -> render');
    expect(k1).toBe(k2);
    expect(k1).toBe('user-matrix-as-user-render');
    expect(k1.length).toBeLessThanOrEqual(60);
  });

  test('resultKey stays within 60 chars for long test names', () => {
    const k = resultKey('user', 'matrix ' + '/campaigns/reports/very/long/route/path'.repeat(3) + ' as user -> render');
    expect(k.length).toBeLessThanOrEqual(60);
  });
});

describe('attachments: mapAttachmentType / attachmentKey / collectAttachments', () => {
  test('maps known attachment names to artifact types', () => {
    expect(mapAttachmentType('trace')).toBe('trace');
    expect(mapAttachmentType('screenshot')).toBe('screenshot');
    expect(mapAttachmentType('video')).toBe('video');
    expect(mapAttachmentType('har')).toBe('har');
    expect(mapAttachmentType('console')).toBe('console');
  });

  test('returns null for unknown attachment names', () => {
    expect(mapAttachmentType('mystery')).toBeNull();
  });

  test('attachmentKey is stable and distinguishes role/test pairs', () => {
    const a = attachmentKey('user', 'matrix / as user -> render');
    const b = attachmentKey('anon', 'matrix / as user -> render');
    expect(a).not.toBe(b);
    expect(attachmentKey('user', 'x')).toBe(attachmentKey('user', 'x'));
  });

  test('collectAttachments walks nested suites and keys by role+title', () => {
    const report = {
      suites: [
        {
          title: 'matrix.spec.ts',
          specs: [
            {
              title: 'matrix / as user -> render',
              tests: [
                {
                  projectName: 'user',
                  results: [
                    {
                      attachments: [
                        { name: 'trace', path: '/tmp/trace.zip', contentType: 'application/zip' },
                        { name: 'har', path: '/tmp/network.har', contentType: 'application/json' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
          suites: [
            {
              specs: [
                {
                  title: 'matrix / as anon -> render',
                  tests: [
                    {
                      projectName: 'anon',
                      results: [{ attachments: [{ name: 'screenshot', path: '/tmp/s.png' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const map = collectAttachments(report as any);
    expect(map.get(attachmentKey('user', 'matrix / as user -> render'))).toEqual([
      { name: 'trace', path: '/tmp/trace.zip', contentType: 'application/zip' },
      { name: 'har', path: '/tmp/network.har', contentType: 'application/json' },
    ]);
    expect(map.get(attachmentKey('anon', 'matrix / as anon -> render'))).toEqual([
      { name: 'screenshot', path: '/tmp/s.png' },
    ]);
  });

  test('collectAttachments returns empty array for tests with no attachments', () => {
    const report = {
      suites: [
        {
          specs: [
            {
              title: 'no attachments here',
              tests: [{ projectName: 'user', results: [{}] }],
            },
          ],
        },
      ],
    };
    const map = collectAttachments(report as any);
    expect(map.get(attachmentKey('user', 'no attachments here'))).toEqual([]);
  });
});

describe('flake: verdict + grep helpers', () => {
  test('isFailureStatus is true only for failed/timed_out', () => {
    expect(isFailureStatus('failed')).toBe(true);
    expect(isFailureStatus('timed_out')).toBe(true);
    expect(isFailureStatus('passed')).toBe(false);
    expect(isFailureStatus('skipped')).toBe(false);
  });

  test('hasAnyFailures detects at least one failing result', () => {
    expect(hasAnyFailures([{ status: 'passed' }, { status: 'failed' }])).toBe(true);
    expect(hasAnyFailures([{ status: 'passed' }, { status: 'skipped' }])).toBe(false);
    expect(hasAnyFailures([])).toBe(false);
  });

  test('isFlaky: reruns_failed < N means flaky', () => {
    expect(isFlaky(0, 3)).toBe(true);
    expect(isFlaky(2, 3)).toBe(true);
    expect(isFlaky(3, 3)).toBe(false);
  });

  test('escapeRegExp escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c?')).toBe('a\\.b\\*c\\?');
    expect(escapeRegExp('matrix /campaigns/reports as user -> render')).toBe(
      'matrix /campaigns/reports as user -> render'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
  });

  test('titleGrepPattern anchors the escaped title with a trailing $', () => {
    expect(titleGrepPattern('matrix / as user -> render')).toBe('matrix / as user -> render$');
    expect(titleGrepPattern('a.b')).toBe('a\\.b$');
  });
});

describe('playwrightArgs: buildMatrixArgs / buildFlakeRerunArgs', () => {
  test('includes setup project when any non-anon role is present', () => {
    expect(buildMatrixArgs(['user', 'anon'])).toEqual([
      'test', '--config', 'tests/playwright.config.ts',
      '--project', 'setup', '--project', 'user', '--project', 'anon',
    ]);
  });

  test('omits setup project when only anon is requested', () => {
    expect(buildMatrixArgs(['anon'])).toEqual([
      'test', '--config', 'tests/playwright.config.ts',
      '--project', 'anon',
    ]);
  });

  test('includes setup for a single non-anon role', () => {
    expect(buildMatrixArgs(['user'])).toEqual([
      'test', '--config', 'tests/playwright.config.ts',
      '--project', 'setup', '--project', 'user',
    ]);
  });

  test('flake rerun args include setup + role, grep pattern, and workers=1', () => {
    const args = buildFlakeRerunArgs('user', 'matrix / as user -> render');
    expect(args).toEqual([
      'test', '--config', 'tests/playwright.config.ts',
      '--project', 'setup', '--project', 'user',
      '--grep', 'matrix / as user -> render$',
      '--workers', '1',
    ]);
  });

  test('flake rerun args omit setup for anon role', () => {
    const args = buildFlakeRerunArgs('anon', 'matrix / as anon -> redirect');
    expect(args).toEqual([
      'test', '--config', 'tests/playwright.config.ts',
      '--project', 'anon',
      '--grep', 'matrix / as anon -> redirect$',
      '--workers', '1',
    ]);
  });

  test('flake rerun args escape regex metacharacters in the title', () => {
    const args = buildFlakeRerunArgs('user', 'weird [title] (with) special.chars?');
    expect(args).toContain('--grep');
    const grepIdx = args.indexOf('--grep');
    expect(args[grepIdx + 1]).toBe('weird \\[title\\] \\(with\\) special\\.chars\\?$');
  });
});

describe('ingest: buildFailedAction / isIngestableProject / buildResultIngest', () => {
  test('buildFailedAction shapes the failed_action object', () => {
    expect(buildFailedAction('Timed out waiting for locator')).toEqual({
      step: null,
      error: 'Timed out waiting for locator',
      actual: null,
    });
    expect(buildFailedAction(null)).toEqual({ step: null, error: null, actual: null });
  });

  test('isIngestableProject excludes the setup project only', () => {
    expect(isIngestableProject('setup')).toBe(false);
    expect(isIngestableProject('user')).toBe(true);
    expect(isIngestableProject('anon')).toBe(true);
  });

  test('buildResultIngest matches the control-plane ResultIngest field set exactly', () => {
    const item = buildResultIngest({
      test_name: 'matrix / as user -> render',
      test_file: 'tests/matrix.spec.ts:26',
      route_path: '/',
      role: 'user',
      status: 'passed',
      duration_ms: 812,
      flaky: false,
      reruns_attempted: 0,
      reruns_failed: 0,
      failed_action: null,
      shell_rendered: null,
      console_summary: [],
      network_summary: [],
      dom_excerpt: null,
      signature_input: null,
      artifacts: [],
    });

    expect(Object.keys(item).sort()).toEqual(
      [
        'test_name', 'test_file', 'route_path', 'role', 'browser', 'viewport',
        'status', 'duration_ms', 'flaky', 'reruns_attempted', 'reruns_failed',
        'failed_action', 'shell_rendered', 'console_summary', 'network_summary',
        'dom_excerpt', 'signature_input', 'artifacts',
      ].sort(),
    );
    expect(item.browser).toBe('chromium');
    expect(item.viewport).toBe('1440x900');
  });

  test('buildResultIngest carries through failed_action, flake counters and artifacts', () => {
    const item = buildResultIngest({
      test_name: 'matrix /campaigns/reports as user -> render',
      test_file: 'tests/matrix.spec.ts:26',
      route_path: '/campaigns/reports',
      role: 'user',
      status: 'failed',
      duration_ms: 9000,
      flaky: true,
      reruns_attempted: 3,
      reruns_failed: 1,
      failed_action: { step: null, error: 'boom', actual: null },
      shell_rendered: null,
      console_summary: [],
      network_summary: [],
      dom_excerpt: null,
      signature_input: null,
      artifacts: [{ type: 'trace', storage_key: 'runs/r1/k1/trace.zip', bytes: 1234 }],
    });
    expect(item.flaky).toBe(true);
    expect(item.reruns_attempted).toBe(3);
    expect(item.reruns_failed).toBe(1);
    expect(item.failed_action).toEqual({ step: null, error: 'boom', actual: null });
    expect(item.artifacts).toEqual([{ type: 'trace', storage_key: 'runs/r1/k1/trace.zip', bytes: 1234 }]);
  });
});

describe('ingest: signature input helpers', () => {
  test('pickFirstErrorEntry returns the first error-level entry', () => {
    const entries = [
      { level: 'warning', text: 'w1', raw_source: null },
      { level: 'error', text: 'e1', raw_source: 'a.js:1:1' },
      { level: 'error', text: 'e2', raw_source: 'b.js:2:2' },
    ];
    expect(pickFirstErrorEntry(entries as any)).toEqual({ level: 'error', text: 'e1', raw_source: 'a.js:1:1' });
  });

  test('pickFirstErrorEntry returns undefined when there is no error entry', () => {
    expect(pickFirstErrorEntry([{ level: 'warning', text: 'w1' }] as any)).toBeUndefined();
  });

  test('resolveSignatureError prefers explicit error_message, then first console error text, then unknown', () => {
    expect(resolveSignatureError('boom', 'console boom')).toBe('boom');
    expect(resolveSignatureError(null, 'console boom')).toBe('console boom');
    expect(resolveSignatureError(null, undefined)).toBe('unknown');
  });

  test('resolveTopFrame prefers resolved source, then raw_source, then empty string', () => {
    expect(resolveTopFrame('src/Foo.tsx:1:2', 'bundle/index.js:1:2')).toBe('src/Foo.tsx:1:2');
    expect(resolveTopFrame(null, 'bundle/index.js:1:2')).toBe('bundle/index.js:1:2');
    expect(resolveTopFrame(null, null)).toBe('');
    expect(resolveTopFrame(undefined, undefined)).toBe('');
  });
});

describe('authExpired: findAuthExpiredFile', () => {
  test('finds a nested AUTH_EXPIRED sentinel file and returns its path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-runner-test-'));
    const nested = path.join(dir, 'user', 'matrix-1');
    fs.mkdirSync(nested, { recursive: true });
    const sentinel = path.join(nested, 'AUTH_EXPIRED');
    fs.writeFileSync(sentinel, 'https://app.example.test/api/session');

    expect(findAuthExpiredFile(dir)).toBe(sentinel);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when no sentinel file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-runner-test-'));
    fs.mkdirSync(path.join(dir, 'user'), { recursive: true });
    expect(findAuthExpiredFile(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns null when the root directory does not exist', () => {
    expect(findAuthExpiredFile('/does/not/exist/at/all')).toBeNull();
  });
});
