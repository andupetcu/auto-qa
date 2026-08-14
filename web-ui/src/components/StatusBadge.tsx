import { makeStyles, mergeClasses } from '@fluentui/react-components';
import { resultStatusMeta, runStatusMeta } from './statusMeta';

const useStyles = makeStyles({
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  pulse: {
    animationName: {
      '0%': { opacity: 1 },
      '50%': { opacity: 0.35 },
      '100%': { opacity: 1 },
    },
    animationDuration: '1.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
  },
});

export function RunStatusBadge({ status }: { status: string }) {
  const styles = useStyles();
  const meta = runStatusMeta(status);
  return (
    <span
      className={mergeClasses(styles.badge, meta.pulse && styles.pulse)}
      style={{ background: meta.bg, color: meta.color }}
    >
      <span className={styles.dot} style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

export function ResultStatusBadge({ status, flaky }: { status: string; flaky?: boolean }) {
  const styles = useStyles();
  const meta = resultStatusMeta(status, flaky);
  return (
    <span className={styles.badge} style={{ background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}
