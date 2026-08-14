import { describe, expect, test } from 'vitest';
import { parseReport } from '../src/reportParser';

const REPORT = {
  suites: [
    {
      title: 'matrix.spec.ts',
      file: 'matrix.spec.ts',
      specs: [
        {
          title: 'matrix / as user -> render',
          file: 'matrix.spec.ts',
          line: 12,
          tests: [
            {
              projectName: 'user',
              results: [{ status: 'passed', duration: 812 }],
            },
          ],
        },
        {
          title: 'matrix /campaigns/reports as user -> render',
          file: 'matrix.spec.ts',
          line: 12,
          tests: [
            {
              projectName: 'user',
              results: [
                {
                  status: 'failed',
                  duration: 8100,
                  error: { message: 'Timed out 5000ms waiting for locator' },
                },
              ],
            },
          ],
        },
        {
          title: 'matrix / as anon -> render',
          file: 'matrix.spec.ts',
          line: 12,
          tests: [
            {
              projectName: 'anon',
              results: [{ status: 'timedOut', duration: 30000, error: { message: 'Test timeout' } }],
            },
          ],
        },
      ],
    },
  ],
};

describe('parseReport', () => {
  test('flattens specs into results with route/role extraction', () => {
    const results = parseReport(REPORT as any);
    expect(results).toHaveLength(3);

    const [ok, failed, timed] = results;
    expect(ok).toMatchObject({
      test_name: 'matrix / as user -> render',
      test_file: 'matrix.spec.ts:12',
      route_path: '/',
      role: 'user',
      status: 'passed',
      duration_ms: 812,
    });
    expect(failed).toMatchObject({
      route_path: '/campaigns/reports',
      status: 'failed',
    });
    expect(failed.error_message).toContain('Timed out');
    expect(timed).toMatchObject({ status: 'timed_out', role: 'anon' });
  });

  test('non-matrix titles get null route and project role', () => {
    const r = parseReport({
      suites: [{
        title: 's', file: 'suites/deeplink.spec.ts',
        specs: [{
          title: 'reports deeplink renders', file: 'suites/deeplink.spec.ts', line: 5,
          tests: [{ projectName: 'user', results: [{ status: 'passed', duration: 10 }] }],
        }],
      }],
    } as any);
    expect(r[0].route_path).toBeNull();
    expect(r[0].role).toBe('user');
  });
});
