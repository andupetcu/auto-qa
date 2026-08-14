import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dropdown, Option, makeStyles, tokens } from '@fluentui/react-components';

import { endpoints } from '../api/endpoints';
import { Mono } from '../components/MonoBlock';
import { COLOR } from '../components/statusMeta';

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
  statRow: {
    display: 'flex',
    gap: '12px',
    marginTop: '20px',
    flexWrap: 'wrap',
  },
  statCard: {
    flex: 1,
    minWidth: '180px',
    padding: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  statValue: {
    fontSize: '26px',
    fontWeight: 600,
  },
  statLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    marginTop: '2px',
  },
  listGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '12px',
    marginTop: '12px',
  },
  listCard: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: '16px',
  },
  listTitle: {
    fontWeight: 600,
    marginBottom: '10px',
  },
  listRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '7px 0',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  path: {
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
    flex: 1,
  },
  source: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  noEntry: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: 'rgba(234,163,0,0.12)',
    color: COLOR.amber,
  },
  footerNote: {
    marginTop: '10px',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
});

export function CoveragePage() {
  const styles = useStyles();
  const [project, setProject] = useState<string | undefined>(undefined);

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: endpoints.projects });
  const matrixQuery = useQuery({
    queryKey: ['matrix', project],
    queryFn: () => endpoints.matrix(project),
  });
  const runsQuery = useQuery({
    queryKey: ['runs', 'coverage', project],
    queryFn: () => endpoints.runs({ limit: 20, status: 'completed' }),
  });

  const latestRun = useMemo(() => {
    const runs = (runsQuery.data ?? []).filter((r) => !project || r.project === project);
    return runs[0];
  }, [runsQuery.data, project]);

  const resultsQuery = useQuery({
    queryKey: ['runResults', latestRun?.id],
    queryFn: () => endpoints.runResults(latestRun!.id),
    enabled: Boolean(latestRun),
  });

  const untested = (matrixQuery.data ?? []).filter(
    (row) => Object.keys(row.expectations).length === 0,
  );

  const flakyResults = (resultsQuery.data ?? []).filter((r) => r.flaky);

  const flakeRate = useMemo(() => {
    const results = resultsQuery.data ?? [];
    const nonSkipped = results.filter((r) => r.status !== 'skipped');
    if (nonSkipped.length === 0) return null;
    const flaky = results.filter((r) => r.flaky).length;
    return (flaky / nonSkipped.length) * 100;
  }, [resultsQuery.data]);

  const totalRoutePairs = (matrixQuery.data ?? []).length;
  const coveredPairs = (matrixQuery.data ?? []).filter(
    (row) => Object.keys(row.expectations).length > 0,
  ).length;
  const coveragePct = totalRoutePairs > 0 ? Math.round((coveredPairs / totalRoutePairs) * 100) : 0;

  return (
    <div className={styles.page}>
      <div className={styles.title}>Coverage &amp; flake</div>
      <div className={styles.subtitle}>
        What the system does not know: routes without expectations, and quarantined flaky
        tests.
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

      <div className={styles.statRow}>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{matrixQuery.data?.length ?? 0}</div>
          <div className={styles.statLabel}>routes discovered</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: COLOR.brand }}>
            {coveragePct}%
          </div>
          <div className={styles.statLabel}>(route × role) pairs with expectations</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: COLOR.passed }}>
            {flakeRate === null ? '—' : `${flakeRate.toFixed(1)}%`}
          </div>
          <div className={styles.statLabel}>flake rate, latest completed run (gate &lt; 5%)</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue} style={{ color: COLOR.amber }}>
            {flakyResults.length}
          </div>
          <div className={styles.statLabel}>quarantined flaky tests</div>
        </div>
      </div>

      <div className={styles.listGrid}>
        <div className={styles.listCard}>
          <div className={styles.listTitle}>Routes without expectations</div>
          {untested.length === 0 ? (
            <div className={styles.source}>Every discovered route has expectations.</div>
          ) : (
            untested.map((row) => (
              <div key={row.path} className={styles.listRow}>
                <span className={styles.path}>{row.path}</span>
                <span className={styles.source}>via {row.source}</span>
                <span className={styles.noEntry}>no matrix entry</span>
              </div>
            ))
          )}
          <div className={styles.footerNote}>
            Add entries to <Mono>role-matrix.yaml</Mono> to cover these.
          </div>
        </div>
        <div className={styles.listCard}>
          <div className={styles.listTitle}>Quarantined flaky tests</div>
          {flakyResults.length === 0 ? (
            <div className={styles.source}>No flaky tests in the latest completed run.</div>
          ) : (
            flakyResults.map((r) => (
              <div key={r.id} className={styles.listRow}>
                <span style={{ flex: 1 }}>{r.test_name}</span>
                <span className={styles.source}>
                  <Mono>
                    {r.route_path} · {r.role}
                  </Mono>
                </span>
                <span className={styles.noEntry}>flaky</span>
              </div>
            ))
          )}
          <div className={styles.footerNote}>
            Failed, then passed on isolated rerun. Excluded from clustering and bundles.
          </div>
        </div>
      </div>
    </div>
  );
}
