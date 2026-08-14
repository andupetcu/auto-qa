import { normalize } from './normalize';

export interface ConsoleEntry {
  level: 'error' | 'warning';
  kind: string;
  text: string;
  source: null;
  raw_source: string | null;
  stack: string | null;
  count: number;
}

interface ConsoleCfg {
  topN: number;
}

interface ConsoleLine {
  kind: string;
  level: string;
  text: string;
  loc?: { url: string; lineNumber: number; columnNumber: number } | null;
  stack?: string | null;
}

export function filterConsole(lines: ConsoleLine[], cfg: ConsoleCfg): ConsoleEntry[] {
  const relevant = lines.filter((l) => l.level === 'error' || l.level === 'warning');

  const byKey = new Map<string, ConsoleEntry>();
  const order: string[] = [];

  for (const line of relevant) {
    const level = line.level as 'error' | 'warning';
    const key = `${level}|${normalize(line.text)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const raw_source = line.loc
      ? `${line.loc.url}:${line.loc.lineNumber}:${line.loc.columnNumber}`
      : null;
    byKey.set(key, {
      level,
      kind: line.kind,
      text: line.text,
      source: null,
      raw_source,
      stack: line.stack ?? null,
      count: 1,
    });
    order.push(key);
  }

  const entries = order.map((key) => byKey.get(key)!);
  const errors = entries.filter((e) => e.level === 'error');
  const warnings = entries.filter((e) => e.level === 'warning');

  return [...errors, ...warnings].slice(0, cfg.topN);
}
