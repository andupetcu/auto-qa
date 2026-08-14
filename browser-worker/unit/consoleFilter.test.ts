import { describe, expect, test } from 'vitest';
import { filterConsole } from '../src/postprocess/consoleFilter';

const line = (over: any) => ({
  kind: 'console', level: 'error', text: 'TypeError: boom',
  loc: { url: 'https://app.test/bundle/index.js', lineNumber: 1, columnNumber: 88214 },
  ...over,
});

describe('filterConsole', () => {
  test('keeps only error and warning levels', () => {
    const rows = filterConsole([
      line({ level: 'log', text: 'hello' }),
      line({ level: 'info', text: 'world' }),
      line({ level: 'warning', text: 'careful' }),
      line({ level: 'error' }),
    ], { topN: 20 });
    expect(rows.map(r => r.level).sort()).toEqual(['error', 'warning']);
  });

  test('dedupes identical messages with count, ids differing only in numbers', () => {
    const rows = filterConsole([
      line({ text: 'Failed for id 123' }),
      line({ text: 'Failed for id 456' }),
      line({ text: 'Failed for id 789' }),
    ], { topN: 20 });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  test('errors sort before warnings and topN caps output', () => {
    const rows = filterConsole([
      line({ level: 'warning', text: 'w1' }),
      line({ level: 'error', text: 'e1' }),
      line({ level: 'warning', text: 'w2' }),
    ], { topN: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].level).toBe('error');
  });

  test('preserves kind and raw_source, leaves source null for later resolution', () => {
    const rows = filterConsole([line({ kind: 'pageerror' })], { topN: 20 });
    expect(rows[0].kind).toBe('pageerror');
    expect(rows[0].raw_source).toBe('https://app.test/bundle/index.js:1:88214');
    expect(rows[0].source).toBeNull();
  });

  test('carries the stack through for later frame resolution (doc 06 §2)', () => {
    const rows = filterConsole([
      line({ kind: 'pageerror', stack: 'TypeError: boom\n    at https://app.test/bundle/index.js:1:88214' }),
      line({ level: 'warning', text: 'no stack here' }),
    ], { topN: 20 });
    expect(rows[0].stack).toContain('at https://app.test/bundle/index.js:1:88214');
    expect(rows[1].stack).toBeNull();
  });
});
