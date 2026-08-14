export type TestStatus = 'passed' | 'failed' | 'timed_out' | 'skipped';

export interface ParsedResult {
  test_name: string;
  test_file: string;
  route_path: string | null;
  role: string;
  status: TestStatus | string;
  duration_ms: number;
  error_message: string | null;
}

const MATRIX_TITLE_RE = /^matrix (\S+) as /;

const STATUS_MAP: Record<string, string> = {
  passed: 'passed',
  failed: 'failed',
  timedOut: 'timed_out',
  skipped: 'skipped',
  interrupted: 'failed',
};

interface RawResult {
  status: string;
  duration: number;
  error?: { message?: string };
}

interface RawTest {
  projectName: string;
  results: RawResult[];
}

interface RawSpec {
  title: string;
  file: string;
  line: number;
  tests: RawTest[];
}

interface RawSuite {
  title?: string;
  file?: string;
  specs?: RawSpec[];
  suites?: RawSuite[];
}

function collectSpecs(suites: RawSuite[] | undefined, out: RawSpec[]): void {
  if (!suites) return;
  for (const suite of suites) {
    if (suite.specs) out.push(...suite.specs);
    if (suite.suites) collectSpecs(suite.suites, out);
  }
}

export function parseReport(report: { suites?: RawSuite[] }): ParsedResult[] {
  const specs: RawSpec[] = [];
  collectSpecs(report?.suites, specs);

  const results: ParsedResult[] = [];

  for (const spec of specs) {
    const routeMatch = spec.title.match(MATRIX_TITLE_RE);
    const route_path = routeMatch ? routeMatch[1] : null;

    for (const test of spec.tests ?? []) {
      // Playwright emits results: [] for tests that never executed — report as skipped
      const lastResult = test.results?.[test.results.length - 1];
      results.push({
        test_name: spec.title,
        test_file: `${spec.file}:${spec.line}`,
        route_path,
        role: test.projectName,
        status: lastResult ? (STATUS_MAP[lastResult.status] ?? lastResult.status) : 'skipped',
        duration_ms: lastResult?.duration ?? 0,
        error_message: lastResult?.error?.message ?? null,
      });
    }
  }

  return results;
}
