import { makeStyles } from '@fluentui/react-components';
import { severityMeta } from './statusMeta';

const useStyles = makeStyles({
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
    whiteSpace: 'nowrap',
  },
});

export function SeverityBadge({ severity }: { severity: string }) {
  const styles = useStyles();
  const meta = severityMeta(severity);
  return (
    <span className={styles.badge} style={{ background: meta.bg, color: meta.color }}>
      {meta.label}
    </span>
  );
}
