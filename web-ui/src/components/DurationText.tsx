import { Mono } from './MonoBlock';

export function formatDurationMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatDurationRange(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return '—';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function DurationText({ ms }: { ms: number }) {
  return <Mono>{formatDurationMs(ms)}</Mono>;
}

export function RunDurationText({
  startedAt,
  endedAt,
}: {
  startedAt: string | null;
  endedAt: string | null;
}) {
  return <Mono>{formatDurationRange(startedAt, endedAt)}</Mono>;
}
