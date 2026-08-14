import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dropdown,
  Option,
  makeStyles,
  tokens,
} from '@fluentui/react-components';

import { endpoints } from '../api/endpoints';
import { Mono } from '../components/MonoBlock';
import { COLOR } from '../components/statusMeta';
import { EmptyState } from '../components/EmptyState';

const useStyles = makeStyles({
  page: {
    padding: '24px',
    maxWidth: '1100px',
  },
  title: {
    fontSize: '20px',
    fontWeight: 600,
  },
  subtitle: {
    marginTop: '4px',
    color: tokens.colorNeutralForeground3,
  },
  picker: {
    marginTop: '16px',
    maxWidth: '260px',
  },
  tableWrap: {
    marginTop: '20px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'auto',
  },
  headerRow: {
    display: 'grid',
    gap: '0 12px',
    padding: '8px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground3,
  },
  dataRow: {
    display: 'grid',
    gap: '0 12px',
    alignItems: 'center',
    padding: '5px 16px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  path: {
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
  },
  source: {
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
  },
  expChip: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
  },
  actual: {
    fontWeight: 600,
  },
  untestedSection: {
    marginTop: '20px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: '16px',
  },
  sectionTitle: {
    fontWeight: 600,
    marginBottom: '10px',
  },
  untestedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '7px 0',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  noEntry: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: 'rgba(234,163,0,0.12)',
    color: COLOR.amber,
  },
});

function actualColor(actual: string | null): string {
  if (!actual) return COLOR.neutral;
  if (actual === 'passed') return COLOR.passed;
  if (actual === 'failed' || actual === 'timed_out') return COLOR.failed;
  return COLOR.neutral;
}

export function MatrixPage() {
  const styles = useStyles();
  const [project, setProject] = useState<string | undefined>(undefined);

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: endpoints.projects });
  const matrixQuery = useQuery({
    queryKey: ['matrix', project],
    queryFn: () => endpoints.matrix(project),
    enabled: Boolean(project) || projectsQuery.isSuccess,
  });

  const roles = useMemo(() => {
    const set = new Set<string>();
    for (const row of matrixQuery.data ?? []) {
      for (const role of Object.keys(row.expectations)) set.add(role);
      for (const role of Object.keys(row.actuals)) set.add(role);
    }
    return Array.from(set).sort();
  }, [matrixQuery.data]);

  const gridTemplate = `minmax(200px,1.2fr) 90px ${roles.map(() => '110px 70px').join(' ')}`;

  const untested = (matrixQuery.data ?? []).filter(
    (row) => Object.keys(row.expectations).length === 0,
  );

  return (
    <div className={styles.page}>
      <div className={styles.title}>Routes &amp; role matrix</div>
      <div className={styles.subtitle}>
        SPA semantics: <Mono>redirect</Mono> asserts the client-side login gate, never HTTP
        status. Actual = latest completed run.
      </div>
      <div className={styles.picker}>
        <Dropdown
          placeholder="All projects"
          value={project ?? ''}
          selectedOptions={project ? [project] : []}
          onOptionSelect={(_, data) => setProject(data.optionValue || undefined)}
        >
          {(projectsQuery.data ?? []).map((p) => (
            <Option key={p.name} value={p.name}>
              {p.name}
            </Option>
          ))}
        </Dropdown>
      </div>

      {matrixQuery.isLoading ? (
        <div className={styles.tableWrap} style={{ padding: '32px' }}>
          Loading matrix&hellip;
        </div>
      ) : !matrixQuery.data || matrixQuery.data.length === 0 ? (
        <EmptyState message="No routes discovered yet for this project." />
      ) : (
        <div className={styles.tableWrap}>
          <div className={styles.headerRow} style={{ gridTemplateColumns: gridTemplate }}>
            <div>Route</div>
            <div>Source</div>
            {roles.map((role) => (
              <Fragment key={role}>
                <div>{role} &middot; expected</div>
                <div>actual</div>
              </Fragment>
            ))}
          </div>
          {matrixQuery.data.map((row) => (
            <div key={row.path} className={styles.dataRow} style={{ gridTemplateColumns: gridTemplate }}>
              <div className={styles.path}>{row.path}</div>
              <div className={styles.source}>{row.source}</div>
              {roles.map((role) => {
                const expected = row.expectations[role];
                const actual = row.actuals[role] ?? null;
                const mismatch = expected && actual && !isConsistent(actual);
                return (
                  <Fragment key={role}>
                    <div>
                      {expected ? <span className={styles.expChip}>{expected}</span> : <span className={styles.source}>&mdash;</span>}
                    </div>
                    <div
                      className={styles.actual}
                      style={{ color: mismatch ? COLOR.failed : actualColor(actual) }}
                    >
                      {actual ?? '—'}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {untested.length > 0 ? (
        <div className={styles.untestedSection}>
          <div className={styles.sectionTitle}>Routes without expectations</div>
          {untested.map((row) => (
            <div key={row.path} className={styles.untestedRow}>
              <span className={styles.path} style={{ flex: 1 }}>
                {row.path}
              </span>
              <span className={styles.source}>via {row.source}</span>
              <span className={styles.noEntry}>no matrix entry</span>
            </div>
          ))}
          <div style={{ marginTop: '10px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
            Add entries to <Mono>role-matrix.yaml</Mono> to cover these.
          </div>
        </div>
      ) : null}
    </div>
  );
}

function isConsistent(actual: string): boolean {
  // A route × role pair is only flagged as a mismatch when the generated
  // matrix test for that expectation actually failed/timed out — "expected"
  // itself doesn't change that check, it only labels the expectation chip.
  return actual !== 'failed' && actual !== 'timed_out';
}
