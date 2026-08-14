import { describe, expect, test } from 'vitest';
import { filterHar } from '../src/postprocess/harFilter';

const entry = (over: any) => ({
  request: { method: 'GET', url: 'https://app.test/api/x' },
  response: { status: 200, content: { text: '' } },
  time: 100,
  ...over,
});

const har = (entries: any[]) => ({ log: { entries } });
const cfg = { bodyBytes: 512, topN: 10, slowMs: 3000 };

describe('filterHar', () => {
  test('drops 2xx static assets and analytics beacons', () => {
    const rows = filterHar(har([
      entry({ request: { method: 'GET', url: 'https://app.test/bundle/index.js' } }),
      entry({ request: { method: 'GET', url: 'https://app.test/img/logo.png' } }),
      entry({ request: { method: 'POST', url: 'https://analytics.example/collect' }, response: { status: 500, content: { text: '' } } }),
      entry({ request: { method: 'GET', url: 'https://app.test/api/ok' } }),
    ]), cfg);
    expect(rows).toEqual([]);
  });

  test('keeps 4xx/5xx, failed and slow requests, ranked by severity', () => {
    const rows = filterHar(har([
      entry({ request: { method: 'GET', url: 'https://app.test/api/slow' }, time: 3500 }),
      entry({ request: { method: 'GET', url: 'https://app.test/api/bad' }, response: { status: 400, content: { text: 'nope' } } }),
      entry({ request: { method: 'GET', url: 'https://app.test/api/boom' }, response: { status: 500, content: { text: 'err' } } }),
      entry({ request: { method: 'GET', url: 'https://app.test/api/dead' }, response: { status: 0, _failureText: 'net::ERR_FAILED', content: { text: '' } } }),
    ]), cfg);
    expect(rows[0].url_path).toBe('/api/boom');       // 5xx first
    expect(rows.map(r => r.url_path)).toContain('/api/slow');
    expect(rows.map(r => r.url_path)).toContain('/api/dead');
    expect(rows).toHaveLength(4);
  });

  test('truncates response bodies and caps rows at topN', () => {
    const big = 'x'.repeat(2000);
    const entries = Array.from({ length: 15 }, (_, i) =>
      entry({ request: { method: 'GET', url: `https://app.test/api/e${i}` },
              response: { status: 500, content: { text: big } } }));
    const rows = filterHar(har(entries), cfg);
    expect(rows).toHaveLength(10);
    expect(rows[0].resp_snippet.length).toBe(512);
  });

  test('url_path preserves query string', () => {
    const rows = filterHar(har([
      entry({ request: { method: 'GET', url: 'https://app.test/api/r?a=1&b=2' },
              response: { status: 500, content: { text: '' } } }),
    ]), cfg);
    expect(rows[0].url_path).toBe('/api/r?a=1&b=2');
  });
});
