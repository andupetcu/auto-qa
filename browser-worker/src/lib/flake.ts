// Flake-rerun protocol helpers (doc 06 §5). Playwright's own retries stay 0 everywhere;
// this is the only retry mechanism, so reruns_attempted/reruns_failed are always truthful.

export function isFailureStatus(status: string): boolean {
  return status === 'failed' || status === 'timed_out';
}

export function hasAnyFailures(results: { status: string }[]): boolean {
  return results.some((r) => isFailureStatus(r.status));
}

// reruns_failed == N -> genuine failure. reruns_failed < N -> flaky (excluded from clustering).
export function isFlaky(rerunsFailed: number, reruns: number): boolean {
  return rerunsFailed < reruns;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Anchors the escaped exact test title so --grep matches only this test, not a prefix of it.
export function titleGrepPattern(title: string): string {
  return `${escapeRegExp(title)}$`;
}
