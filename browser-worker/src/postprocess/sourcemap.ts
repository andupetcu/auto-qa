import { SourceMapConsumer } from 'source-map';

export type Fetcher = (url: string) => Promise<{ ok: boolean; text: string }>;

const FRAME_RE = /^(.*):(\d+):(\d+)$/;
const SOURCE_MAPPING_URL_RE = /\/\/#\s*sourceMappingURL=(\S+)/;
const WEBPACK_PREFIX_RE = /^webpack:\/\/[^/]*\//;

export async function resolveFrame(raw: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const match = raw.match(FRAME_RE);
    if (!match) return null;

    const [, scriptUrl, lineStr, columnStr] = match;
    if (!scriptUrl.includes('://')) return null;

    const line = Number(lineStr);
    const column = Number(columnStr);

    const scriptRes = await fetcher(scriptUrl);
    if (!scriptRes.ok) return null;

    let mapUrl: string;
    const mappingMatch = scriptRes.text.match(SOURCE_MAPPING_URL_RE);
    if (mappingMatch) {
      mapUrl = new URL(mappingMatch[1], scriptUrl).toString();
    } else {
      mapUrl = `${scriptUrl}.map`;
    }

    const mapRes = await fetcher(mapUrl);
    if (!mapRes.ok) return null;

    const consumer = await new SourceMapConsumer(mapRes.text);
    try {
      const pos = consumer.originalPositionFor({ line, column });
      if (pos.source == null || pos.line == null || pos.column == null) return null;
      const source = pos.source.replace(WEBPACK_PREFIX_RE, '');
      return `${source}:${pos.line}:${pos.column}`;
    } finally {
      consumer.destroy();
    }
  } catch {
    return null;
  }
}
