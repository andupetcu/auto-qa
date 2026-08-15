/** @fileoverview Live Auto QA run detail, results, bundles, and rerun controls. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  Tab,
  TabList,
  createTableColumn,
  makeStyles,
  tokens,
  type TableColumnDefinition,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';

import { endpoints } from '../api/endpoints';
import type { Run, TestResult } from '../api/types';
import { RunStatusBadge, ResultStatusBadge } from '../components/StatusBadge';
import { SeverityBadge } from '../components/SeverityBadge';
import { TotalsCards } from '../components/Totals';
import { Mono } from '../components/MonoBlock';
import { DurationText, formatDurationRange } from '../components/DurationText';
import { EmptyState } from '../components/EmptyState';
import { ResultDrawer } from '../drawers/ResultDrawer';
import { BundleDrawer } from '../drawers/BundleDrawer';
import { RunProgressView } from '../components/RunProgress';

const useStyles = makeStyles({
  page: {
    padding: '24px',
    maxWidth: '1200px',
  },
  progressWrap: {
    marginTop: '12px',
    maxWidth: '520px',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginTop: '10px',
    flexWrap: 'wrap',
  },
  runId: {
    fontSize: '18px',
    fontWeight: 600,
  },
  spacer: { flex: 1 },
  metaRow: {
    display: 'flex',
    gap: '16px',
    marginTop: '8px',
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    flexWrap: 'wrap',
  },
  metaValue: {
    color: tokens.colorNeutralForeground1,
  },
  totalsWrap: {
    marginTop: '16px',
  },
  tabs: {
    marginTop: '20px',
  },
  gridWrap: {
    marginTop: '16px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'auto',
  },
  row: {
    cursor: 'pointer',
  },
  bundleList: {
    marginTop: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  bundleCard: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    padding: '14px 16px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    cursor: 'pointer',
  },
  bundleTitle: {
    fontWeight: 600,
  },
  bundleMeta: {
    marginTop: '2px',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
  },
  chevron: {
    color: tokens.colorNeutralForeground4,
  },
});

export function RunDetailPage() {
  const styles = useStyles();
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<'results' | 'bundles'>('results');

  const resultParam = searchParams.get('result');
  const bundleParam = searchParams.get('bundle');

  const runQuery = useQuery({
    queryKey: ['run', runId],
    queryFn: () => endpoints.run(runId as string),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const run = query.state.data as Run | undefined;
      return run && (run.status === 'queued' || run.status === 'running') ? 2000 : false;
    },
  });

  const runStatus = runQuery.data?.status;
  const runIsActive = runStatus === 'queued' || runStatus === 'running';
  const previousRunStatus = useRef<Run['status'] | undefined>(undefined);

  const resultsQuery = useQuery({
    queryKey: ['runResults', runId],
    queryFn: () => endpoints.runResults(runId as string),
    enabled: Boolean(runId),
    refetchInterval: runIsActive ? 2000 : false,
  });

  const bundlesQuery = useQuery({
    queryKey: ['runBundles', runId],
    queryFn: () => endpoints.runBundles(runId as string),
    enabled: Boolean(runId),
    refetchInterval: runIsActive ? 2000 : false,
  });

  useEffect(() => {
    const previousStatus = previousRunStatus.current;
    previousRunStatus.current = runStatus;
    const wasActive = previousStatus === 'queued' || previousStatus === 'running';
    if (!runId || !wasActive || runIsActive) return;

    // Fetch once after the terminal transition so late-ingested results and bundles
    // cannot leave the detail page showing the previous polling response.
    void queryClient.invalidateQueries({ queryKey: ['runResults', runId] });
    void queryClient.invalidateQueries({ queryKey: ['runBundles', runId] });
    void queryClient.invalidateQueries({ queryKey: ['runs'] });
  }, [queryClient, runId, runIsActive, runStatus]);

  const rerunMutation = useMutation({
    mutationFn: (scope: 'failed' | 'full') => endpoints.rerun(runId as string, { scope }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      navigate(`/runs/${res.run_id}`);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => endpoints.cancelRun(runId as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['run', runId] });
      queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const columns = useMemo<TableColumnDefinition<TestResult>[]>(
    () => [
      createTableColumn<TestResult>({
        columnId: 'test',
        renderHeaderCell: () => 'Test',
        renderCell: (t) => t.test_name,
      }),
      createTableColumn<TestResult>({
        columnId: 'route',
        renderHeaderCell: () => 'Route',
        renderCell: (t) => <Mono>{t.route_path}</Mono>,
      }),
      createTableColumn<TestResult>({
        columnId: 'role',
        renderHeaderCell: () => 'Role',
        renderCell: (t) => t.role,
      }),
      createTableColumn<TestResult>({
        columnId: 'browser',
        renderHeaderCell: () => 'Browser',
        renderCell: (t) => t.browser,
      }),
      createTableColumn<TestResult>({
        columnId: 'viewport',
        renderHeaderCell: () => 'Viewport',
        renderCell: (t) => <Mono>{t.viewport}</Mono>,
      }),
      createTableColumn<TestResult>({
        columnId: 'status',
        renderHeaderCell: () => 'Status',
        renderCell: (t) => <ResultStatusBadge status={t.status} flaky={t.flaky} />,
      }),
      createTableColumn<TestResult>({
        columnId: 'duration',
        renderHeaderCell: () => 'Time',
        renderCell: (t) => <DurationText ms={t.duration_ms} />,
      }),
    ],
    [],
  );

  const selectedResult = useMemo(
    () => resultsQuery.data?.find((r) => r.id === resultParam) ?? null,
    [resultsQuery.data, resultParam],
  );
  const matchingBundle = useMemo(() => {
    if (!selectedResult) return null;
    return (
      bundlesQuery.data?.find(
        (b) =>
          b.test.name === selectedResult.test_name &&
          b.affected.some((a) => a.route === selectedResult.route_path && a.role === selectedResult.role),
      ) ?? null
    );
  }, [bundlesQuery.data, selectedResult]);
  const selectedBundle = useMemo(
    () => bundlesQuery.data?.find((b) => b.bundle_id === bundleParam) ?? null,
    [bundlesQuery.data, bundleParam],
  );

  if (!runId) return null;

  const run = runQuery.data;
  const hasFailed = (run?.totals?.failed ?? 0) > 0;
  const isActive = run?.status === 'queued' || run?.status === 'running';

  function openResult(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set('result', id);
    setSearchParams(next);
  }
  function closeResult() {
    const next = new URLSearchParams(searchParams);
    next.delete('result');
    setSearchParams(next);
  }
  function openBundle(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set('bundle', id);
    setSearchParams(next);
  }
  function closeBundle() {
    const next = new URLSearchParams(searchParams);
    next.delete('bundle');
    setSearchParams(next);
  }

  return (
    <div className={styles.page}>
      <RouterLink to="/runs" style={{ fontSize: '12px' }}>
        &larr; All runs
      </RouterLink>
      <div className={styles.headerRow}>
        <div className={styles.runId}>
          <Mono>{runId}</Mono>
        </div>
        {run ? <RunStatusBadge status={run.status} /> : null}
        <div className={styles.spacer} />
        {isActive ? (
          <Button
            appearance="primary"
            icon={<Dismiss20Regular />}
            onClick={() => cancelMutation.mutate()}
            disabled={cancelMutation.isPending}
          >
            Stop run
          </Button>
        ) : (
          <>
            {hasFailed ? (
              <Button
                appearance="primary"
                onClick={() => rerunMutation.mutate('failed')}
                disabled={rerunMutation.isPending}
              >
                Rerun failed scope
              </Button>
            ) : null}
            <Button onClick={() => rerunMutation.mutate('full')} disabled={rerunMutation.isPending}>
              Rerun full
            </Button>
          </>
        )}
      </div>
      {run && isActive && run.progress ? (
        <div className={styles.progressWrap}>
          <RunProgressView progress={run.progress} />
        </div>
      ) : null}
      {run ? (
        <div className={styles.metaRow}>
          <span>
            project: <span className={styles.metaValue}>{run.project}</span>
          </span>
          <span>
            trigger: <span className={styles.metaValue}>{run.trigger}</span>
          </span>
          <span>
            target: <span className={styles.metaValue}><Mono>{run.base_url}</Mono></span>
          </span>
          <span>
            app_version: <span className={styles.metaValue}>{run.app_version ?? '—'}</span>
          </span>
          <span>
            started: <span className={styles.metaValue}>{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</span>
          </span>
          <span>
            duration:{' '}
            <span className={styles.metaValue}>
              <Mono>{formatDurationRange(run.started_at, run.ended_at)}</Mono>
            </span>
          </span>
          {run.parent_run_id ? (
            <span>
              rerun of{' '}
              <RouterLink to={`/runs/${run.parent_run_id}`}>
                <Mono>{run.parent_run_id}</Mono>
              </RouterLink>
            </span>
          ) : null}
        </div>
      ) : null}

      {run ? (
        <div className={styles.totalsWrap}>
          <TotalsCards totals={run.totals} />
        </div>
      ) : null}

      <div className={styles.tabs}>
        <TabList
          selectedValue={tab}
          onTabSelect={(_, data) => setTab(data.value as 'results' | 'bundles')}
        >
          <Tab value="results">Results {resultsQuery.data ? `(${resultsQuery.data.length})` : ''}</Tab>
          <Tab value="bundles">
            Failure bundles {bundlesQuery.data ? `(${bundlesQuery.data.length})` : ''}
          </Tab>
        </TabList>
      </div>

      {tab === 'results' ? (
        resultsQuery.isLoading ? (
          <div className={styles.gridWrap} style={{ padding: '32px' }}>
            Loading results…
          </div>
        ) : !resultsQuery.data || resultsQuery.data.length === 0 ? (
          <EmptyState message="No results yet for this run." />
        ) : (
          <div className={styles.gridWrap}>
            <DataGrid items={resultsQuery.data} columns={columns} getRowId={(t) => t.id} size="small">
              <DataGridHeader>
                <DataGridRow>
                  {({ renderHeaderCell }) => (
                    <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                  )}
                </DataGridRow>
              </DataGridHeader>
              <DataGridBody<TestResult>>
                {({ item, rowId }) => (
                  <DataGridRow<TestResult>
                    key={rowId}
                    className={styles.row}
                    onClick={() => openResult(item.id)}
                  >
                    {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                  </DataGridRow>
                )}
              </DataGridBody>
            </DataGrid>
          </div>
        )
      ) : bundlesQuery.isLoading ? (
        <div className={styles.gridWrap} style={{ padding: '32px' }}>
          Loading bundles…
        </div>
      ) : !bundlesQuery.data || bundlesQuery.data.length === 0 ? (
        <EmptyState message="No failure bundles — all genuine failures resolved or none occurred. Flaky results are quarantined and never bundled." />
      ) : (
        <div className={styles.bundleList}>
          {bundlesQuery.data.map((b) => (
            <div
              key={b.bundle_id}
              className={styles.bundleCard}
              onClick={() => openBundle(b.bundle_id)}
            >
              <SeverityBadge severity={b.severity} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={styles.bundleTitle}>{b.test.name}</div>
                <div className={styles.bundleMeta}>
                  {b.cluster_id} &middot; {b.occurrences} occurrence(s) &middot;{' '}
                  {b.affected.map((a) => `${a.route} · ${a.role}`).join(', ')}
                </div>
              </div>
              <div className={styles.chevron}>&rsaquo;</div>
            </div>
          ))}
        </div>
      )}

      <ResultDrawer
        result={selectedResult}
        open={Boolean(resultParam)}
        matchingBundle={matchingBundle}
        onClose={closeResult}
        onOpenBundle={openBundle}
      />
      <BundleDrawer bundle={selectedBundle} open={Boolean(bundleParam)} onClose={closeBundle} />
    </div>
  );
}
