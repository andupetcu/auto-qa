import { describe, expect, test } from 'vitest';
import { SourceMapGenerator } from 'source-map';
import { resolveFrame } from '../src/postprocess/sourcemap';

function makeMap(): string {
  const gen = new SourceMapGenerator({ file: 'app.js' });
  gen.addMapping({
    generated: { line: 1, column: 10 },
    original: { line: 42, column: 5 },
    source: 'webpack://app/src/components/Budget.tsx',
  });
  return gen.toString();
}

describe('resolveFrame', () => {
  test('resolves a minified frame through a source map', async () => {
    const fetcher = async (url: string) => {
      if (url === 'https://app.test/app.js') {
        return { ok: true, text: 'var x=1;\n//# sourceMappingURL=app.js.map' };
      }
      if (url === 'https://app.test/app.js.map') {
        return { ok: true, text: makeMap() };
      }
      return { ok: false, text: '' };
    };
    const resolved = await resolveFrame('https://app.test/app.js:1:10', fetcher);
    expect(resolved).toBe('src/components/Budget.tsx:42:5');
  });

  test('returns null when no map is served (silent fallback)', async () => {
    const fetcher = async () => ({ ok: false, text: '' });
    expect(await resolveFrame('https://app.test/app.js:1:10', fetcher)).toBeNull();
  });

  test('returns null for unparseable frames', async () => {
    const fetcher = async () => ({ ok: true, text: '' });
    expect(await resolveFrame('not-a-frame', fetcher)).toBeNull();
  });
});
