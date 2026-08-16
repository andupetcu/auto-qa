/** @fileoverview Privacy-safe normalization for public Auto QA route metadata. */

/** Return only a local pathname, excluding query strings and fragments. */
export function normalizeRoutePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  const queryIndex = value.indexOf('?');
  const fragmentIndex = value.indexOf('#');
  const boundaries = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : value.length;
  return value.slice(0, end) || '/';
}

/** Prefer report metadata, then a manifest fallback, while enforcing route privacy. */
export function resolveRoutePath(reportRoute: unknown, manifestRoute: unknown): string | null {
  return normalizeRoutePath(reportRoute) ?? normalizeRoutePath(manifestRoute);
}
