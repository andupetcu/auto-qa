// Central status -> color mapping shared by StatusBadge and any other status
// dots/pills. Hex values come from the mockup palette (docs/plans/web-ui-build.md).

export const COLOR = {
  brand: '#479ef5',
  passed: '#54b054',
  failed: '#dc626d',
  amber: '#eaa300',
  neutral: '#9e9e9e',
};

export interface StatusMeta {
  label: string;
  color: string;
  bg: string;
  pulse?: boolean;
}

function tint(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function runStatusMeta(status: string): StatusMeta {
  switch (status) {
    case 'running':
      return { label: 'running', color: COLOR.brand, bg: tint(COLOR.brand, 0.12), pulse: true };
    case 'queued':
      return { label: 'queued', color: COLOR.neutral, bg: tint(COLOR.neutral, 0.12) };
    case 'auth_expired':
      return { label: 'auth_expired', color: COLOR.amber, bg: tint(COLOR.amber, 0.12) };
    case 'failed':
      return { label: 'failed', color: COLOR.failed, bg: tint(COLOR.failed, 0.12) };
    case 'canceled':
      return { label: 'canceled', color: COLOR.neutral, bg: tint(COLOR.neutral, 0.12) };
    case 'completed':
      return { label: 'completed', color: COLOR.passed, bg: tint(COLOR.passed, 0.12) };
    default:
      return { label: status, color: COLOR.neutral, bg: tint(COLOR.neutral, 0.12) };
  }
}

export function resultStatusMeta(status: string, flaky?: boolean): StatusMeta {
  if (flaky) {
    return { label: 'flaky', color: COLOR.amber, bg: tint(COLOR.amber, 0.12) };
  }
  switch (status) {
    case 'passed':
      return { label: 'passed', color: COLOR.passed, bg: tint(COLOR.passed, 0.12) };
    case 'failed':
      return { label: 'failed', color: COLOR.failed, bg: tint(COLOR.failed, 0.12) };
    case 'timed_out':
      return { label: 'timed_out', color: COLOR.failed, bg: tint(COLOR.failed, 0.12) };
    case 'skipped':
      return { label: 'skipped', color: COLOR.neutral, bg: tint(COLOR.neutral, 0.12) };
    default:
      return { label: status, color: COLOR.neutral, bg: tint(COLOR.neutral, 0.12) };
  }
}

export function severityMeta(severity: string): StatusMeta {
  switch (severity) {
    case 'high':
      return { label: 'high', color: COLOR.failed, bg: tint(COLOR.failed, 0.14) };
    case 'medium':
      return { label: 'medium', color: COLOR.amber, bg: tint(COLOR.amber, 0.14) };
    case 'low':
      return { label: 'low', color: COLOR.brand, bg: tint(COLOR.brand, 0.14) };
    default:
      return { label: severity, color: COLOR.neutral, bg: tint(COLOR.neutral, 0.14) };
  }
}
