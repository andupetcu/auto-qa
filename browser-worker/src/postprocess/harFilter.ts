/**
 * @fileoverview Bounded HAR diagnostics for every Auto QA result. Pending
 * responses are explicit and query strings are never projected into summaries.
 */
export interface NetworkFailure {
  kind?: 'pending' | 'request_failed' | 'http_error' | 'slow';
  method: string;
  url_path: string;
  resource_type?: string;
  status: number;
  timing_ms: number;
  resp_snippet: string;
  failure?: string | null;
}

export interface NetworkCollectorSummary {
  kind: 'summary';
  collector_status: 'completed';
  total_entries: number;
  status_counts: Record<string, number>;
  pending: number;
  request_failures: number;
  http_4xx: number;
  http_5xx: number;
  slow: number;
}

interface HarCfg {
  bodyBytes: number;
  topN: number;
  slowMs: number;
}

const STATIC_ASSET_RE = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;
const ANALYTICS_RE = /analytics|telemetry|sentry|posthog|gtag|beacon/i;

function safePath(raw: string): string {
  try { return new URL(raw).pathname; } catch { return raw.split(/[?#]/, 1)[0].slice(0, 500); }
}

function classify(entry: any, cfg: HarCfg): NetworkFailure['kind'] | null {
  const status = Number(entry.response?.status ?? 0);
  const failure = entry.response?._failureText ?? entry._failureText ?? null;
  if (failure) return 'request_failed';
  if (status <= 0) return 'pending';
  if (status >= 400) return 'http_error';
  if (typeof entry.time === 'number' && entry.time > cfg.slowMs) return 'slow';
  return null;
}

function relevantEntries(har: any, cfg: HarCfg): Array<{ entry: any; kind: NonNullable<NetworkFailure['kind']>; index: number }> {
  const entries: any[] = har?.log?.entries ?? [];
  return entries.flatMap((entry, index) => {
    const kind = classify(entry, cfg);
    if (!kind) return [];
    const url = String(entry.request?.url ?? '');
    if (ANALYTICS_RE.test(url)) return [];
    if (kind === 'slow' && STATIC_ASSET_RE.test(url)) return [];
    return [{ entry, kind, index }];
  });
}

function rank(kind: NonNullable<NetworkFailure['kind']>, status: number): number {
  if (kind === 'request_failed' || status >= 500) return 0;
  if (kind === 'pending') return 1;
  if (status >= 400) return 2;
  return 3;
}

export function filterHar(har: any, cfg: HarCfg): NetworkFailure[] {
  const relevant = relevantEntries(har, cfg);
  relevant.sort((left, right) => {
    const difference = rank(left.kind, Number(left.entry.response?.status ?? 0))
      - rank(right.kind, Number(right.entry.response?.status ?? 0));
    return difference || left.index - right.index;
  });
  return relevant.slice(0, cfg.topN).map(({ entry, kind }) => {
    const text = String(entry.response?.content?.text ?? '');
    const failure = entry.response?._failureText ?? entry._failureText ?? null;
    return {
      kind,
      method: String(entry.request?.method ?? ''),
      url_path: safePath(String(entry.request?.url ?? '')),
      resource_type: String(entry._resourceType ?? entry.request?._resourceType ?? ''),
      status: Number(entry.response?.status ?? 0),
      timing_ms: Math.round(Number(entry.time ?? -1)),
      resp_snippet: text.slice(0, cfg.bodyBytes),
      failure: failure ? String(failure).slice(0, 500) : null,
    };
  });
}

export function analyzeHar(har: any, cfg: HarCfg): Array<NetworkCollectorSummary | NetworkFailure> {
  const entries: any[] = har?.log?.entries ?? [];
  const statusCounts: Record<string, number> = {};
  for (const entry of entries) {
    const status = Number(entry.response?.status ?? 0);
    const key = String(status);
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }
  const classified = entries.map((entry) => ({ entry, kind: classify(entry, cfg) }));
  const summary: NetworkCollectorSummary = {
    kind: 'summary',
    collector_status: 'completed',
    total_entries: entries.length,
    status_counts: statusCounts,
    pending: classified.filter(({ kind }) => kind === 'pending').length,
    request_failures: classified.filter(({ kind }) => kind === 'request_failed').length,
    http_4xx: entries.filter((entry) => Number(entry.response?.status ?? 0) >= 400 && Number(entry.response?.status ?? 0) < 500).length,
    http_5xx: entries.filter((entry) => Number(entry.response?.status ?? 0) >= 500).length,
    slow: classified.filter(({ kind }) => kind === 'slow').length,
  };
  return [summary, ...filterHar(har, cfg)];
}
