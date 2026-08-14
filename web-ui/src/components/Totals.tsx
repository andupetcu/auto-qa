import { makeStyles, tokens } from '@fluentui/react-components';
import { COLOR } from './statusMeta';
import { monoFontFamily } from './MonoBlock';
import type { RunTotals } from '../api/types';

const useStyles = makeStyles({
  cards: {
    display: 'flex',
    gap: '12px',
  },
  card: {
    padding: '10px 16px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    minWidth: '84px',
  },
  value: {
    fontSize: '22px',
    fontWeight: 600,
  },
  label: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  inline: {
    display: 'flex',
    gap: '10px',
    fontSize: '12px',
    fontFamily: monoFontFamily,
  },
});

export function TotalsCards({ totals }: { totals: RunTotals | null }) {
  const styles = useStyles();
  const t = totals ?? { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  return (
    <div className={styles.cards}>
      <div className={styles.card}>
        <div className={styles.value} style={{ color: COLOR.passed }}>
          {t.passed}
        </div>
        <div className={styles.label}>passed</div>
      </div>
      <div className={styles.card}>
        <div className={styles.value} style={{ color: t.failed > 0 ? COLOR.failed : undefined }}>
          {t.failed}
        </div>
        <div className={styles.label}>failed</div>
      </div>
      <div className={styles.card}>
        <div className={styles.value} style={{ color: t.flaky > 0 ? COLOR.amber : undefined }}>
          {t.flaky}
        </div>
        <div className={styles.label}>flaky · quarantined</div>
      </div>
      <div className={styles.card}>
        <div className={styles.value} style={{ color: COLOR.neutral }}>
          {t.skipped}
        </div>
        <div className={styles.label}>skipped</div>
      </div>
    </div>
  );
}

export function TotalsInline({ totals }: { totals: RunTotals | null }) {
  const styles = useStyles();
  // runs are queued/running before finalize sets totals — show a dash, never crash
  if (!totals) {
    return <span style={{ color: COLOR.neutral }}>&#8212;</span>;
  }
  return (
    <div className={styles.inline}>
      <span style={{ color: COLOR.passed }}>{totals.passed} &#10003;</span>
      <span style={{ color: totals.failed > 0 ? COLOR.failed : COLOR.neutral }}>
        {totals.failed} &#10007;
      </span>
      <span style={{ color: totals.flaky > 0 ? COLOR.amber : COLOR.neutral }}>
        {totals.flaky} ~
      </span>
    </div>
  );
}
