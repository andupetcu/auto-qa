export interface NetworkFailure {
  method: string;
  url_path: string;
  status: number;
  timing_ms: number;
  resp_snippet: string;
}

interface HarCfg {
  bodyBytes: number;
  topN: number;
  slowMs: number;
}

const STATIC_ASSET_RE = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;
const ANALYTICS_RE = /analytics|telemetry|sentry|posthog|gtag|beacon/i;

export function filterHar(har: any, cfg: HarCfg): NetworkFailure[] {
  const entries: any[] = har?.log?.entries ?? [];

  const kept = entries.filter((entry) => {
    const status = entry.response?.status ?? 0;
    const hasFailure = !!entry.response?._failureText;
    const isSlow = typeof entry.time === 'number' && entry.time > cfg.slowMs;
    const initiallyKept = status >= 400 || hasFailure || isSlow;
    if (!initiallyKept) return false;

    const url: string = entry.request?.url ?? '';
    if (ANALYTICS_RE.test(url)) return false;
    if (status < 400 && STATIC_ASSET_RE.test(url)) return false;

    return true;
  });

  const withRank = kept.map((entry, idx) => {
    const status = entry.response?.status ?? 0;
    const hasFailure = !!entry.response?._failureText;
    let rank: number;
    if (status >= 500 || hasFailure) rank = 0;
    else if (status >= 400) rank = 1;
    else rank = 2;
    return { entry, idx, rank };
  });

  withRank.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.idx - b.idx;
  });

  const bodyBytes = cfg.bodyBytes;

  return withRank.slice(0, cfg.topN).map(({ entry }) => {
    const url: string = entry.request?.url ?? '';
    let urlPath = url;
    try {
      const parsed = new URL(url);
      urlPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      // leave as-is if not a valid absolute URL
    }
    const text: string = entry.response?.content?.text ?? '';
    return {
      method: entry.request?.method ?? '',
      url_path: urlPath,
      status: entry.response?.status ?? 0,
      timing_ms: Math.round(entry.time ?? 0),
      resp_snippet: text.slice(0, bodyBytes),
    };
  });
}
