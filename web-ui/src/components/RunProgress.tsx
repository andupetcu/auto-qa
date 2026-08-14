import { makeStyles, ProgressBar, tokens } from '@fluentui/react-components';
import type { RunProgress as RunProgressData } from '../api/types';

const PHASE_LABEL: Record<string, string> = {
  starting: 'Starting',
  running: 'Running suite',
  'flake-reruns': 'Flake reruns',
  'post-processing': 'Post-processing',
  finalizing: 'Finalizing',
};

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '240px' },
  line: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  phase: { color: tokens.colorNeutralForeground1, fontWeight: tokens.fontWeightSemibold },
  current: {
    fontFamily: 'Consolas, "Cascadia Mono", monospace',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '340px',
  },
});

// Live run progress. Determinate bar when the worker knows a total, indeterminate
// otherwise (e.g. the "starting" phase before the suite is planned).
export function RunProgressView({ progress }: { progress: RunProgressData }) {
  const styles = useStyles();
  const label = PHASE_LABEL[progress.phase] ?? progress.phase;
  const hasCount = typeof progress.total === 'number' && progress.total > 0;
  const done = progress.done ?? 0;
  const total = progress.total ?? 0;
  return (
    <div className={styles.wrap}>
      <div className={styles.line}>
        <span className={styles.phase}>{label}</span>
        {hasCount ? <span>{done}/{total}</span> : null}
      </div>
      <ProgressBar
        thickness="large"
        value={hasCount ? done / total : undefined}
        max={1}
      />
      {progress.current ? <span className={styles.current}>{progress.current}</span> : null}
    </div>
  );
}
