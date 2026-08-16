/** @fileoverview Unit coverage for role applicability and skipped-case suppression. */
import { describe, expect, test } from 'vitest';
import { isApplicableResult, parseReport, resolveRoutePath, type ParsedResult } from '../src/reportParser';

function result(testName: string, role: string, status = 'skipped'): ParsedResult {
  return {
    test_name: testName, test_file: 'matrix.spec.ts', route_path: '/', role,
    status, duration_ms: 0, error_message: null,
  };
}

describe('isApplicableResult', () => {
  test('drops only opposite-role matrix skips', () => {
    expect(isApplicableResult(result('matrix / as anon -> redirect', 'user'))).toBe(false);
    expect(isApplicableResult(result('matrix / as user -> render', 'user'))).toBe(true);
    expect(isApplicableResult(result('custom applicable skip', 'user'))).toBe(true);
    expect(isApplicableResult(result('matrix / as anon -> redirect', 'user', 'passed'))).toBe(true);
  });
});


describe('parseReport route privacy', () => {
  test('projects matrix routes as pathname-only metadata', () => {
    const parsed = parseReport({
      suites: [{
        specs: [{
          title: 'matrix /campaigns/reports?view=secret#chart as user -> render',
          file: 'matrix.spec.ts',
          line: 12,
          tests: [{ projectName: 'user', results: [{ status: 'passed', duration: 1 }] }],
        }],
      }],
    });

    expect(parsed[0]?.route_path).toBe('/campaigns/reports');
  });

  test('sanitizes manifest fallback routes and rejects protocol-relative metadata', () => {
    expect(resolveRoutePath(null, '/reports/deep-link?view=secret#chart')).toBe('/reports/deep-link');
    expect(resolveRoutePath('/from-report?token=secret', '/from-manifest?token=secret')).toBe('/from-report');
    expect(resolveRoutePath(null, '//external.example/secret')).toBeNull();
  });
});
