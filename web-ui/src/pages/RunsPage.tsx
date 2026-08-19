/** @fileoverview Paginated run history with live status refresh. */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  createTableColumn,
  makeStyles,
  tokens,
  type TableColumnDefinition,
  type DataGridProps,
} from '@fluentui/react-components';

import { endpoints } from '../api/endpoints';
import type { Run } from '../api/types';
import { RunStatusBadge } from '../components/StatusBadge';
import { TotalsInline } from '../components/Totals';
import { Mono } from '../components/MonoBlock';
import { formatDurationRange } from '../components/DurationText';
import { EmptyState } from '../components/EmptyState';

const useStyles = makeStyles({
  page: {
    padding: '24px',
    maxWidth: '1200px',
  },
  title: {
    fontSize: '20px',
    fontWeight: 600,
  },
  subtitle: {
    marginTop: '4px',
    color: tokens.colorNeutralForeground3,
  },
  gridWrap: {
    marginTop: '20px',
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    overflow: 'auto',
  },
  row: {
    cursor: 'pointer',
  },
  targetProject: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  targetUrl: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  shortId: {
    fontSize: '12px',
  },
  parentTag: {
    color: tokens.colorNeutralForeground4,
    marginLeft: '4px',
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 18)}…` : id;
}

export function RunsPage() {
  const styles = useStyles();
  const navigate = useNavigate();

  const [sortState, setSortState] = useState<DataGridProps['sortState']>({
    sortColumn: 'started',
    sortDirection: 'descending',
  });

  const { data: runs, isLoading } = useQuery({
    queryKey: ['runs', 'history', { limit: 50 }],
    queryFn: () => endpoints.runs({ limit: 50 }),
    refetchInterval: (query) => {
      const list = query.state.data as Run[] | undefined;
      const active = list?.some((r) => r.status === 'queued' || r.status === 'running');
      return active ? 3000 : 15000;
    },
  });

  const columns = useMemo<TableColumnDefinition<Run>[]>(
    () => [
      createTableColumn<Run>({
        columnId: 'run',
        renderHeaderCell: () => 'Run',
        renderCell: (r) => (
          <span className={styles.shortId}>
            <Mono>{shortId(r.id)}</Mono>
            {r.parent_run_id ? <span className={styles.parentTag}>rerun</span> : null}
          </span>
        ),
        compare: (a, b) => a.id.localeCompare(b.id),
      }),
      createTableColumn<Run>({
        columnId: 'status',
        renderHeaderCell: () => 'Status',
        renderCell: (r) => <RunStatusBadge status={r.status} />,
        compare: (a, b) => a.status.localeCompare(b.status),
      }),
      createTableColumn<Run>({
        columnId: 'trigger',
        renderHeaderCell: () => 'Trigger',
        renderCell: (r) => <span className={styles.muted}>{r.trigger}</span>,
        compare: (a, b) => a.trigger.localeCompare(b.trigger),
      }),
      createTableColumn<Run>({
        columnId: 'target',
        renderHeaderCell: () => 'Target',
        renderCell: (r) => (
          <div style={{ minWidth: 0 }}>
            <div className={styles.targetProject}>{r.project}</div>
            <div className={styles.targetUrl}>
              <Mono>
                {r.base_url} {r.app_version ?? ''}
              </Mono>
            </div>
          </div>
        ),
        compare: (a, b) => a.project.localeCompare(b.project),
      }),
      createTableColumn<Run>({
        columnId: 'results',
        renderHeaderCell: () => 'Results',
        renderCell: (r) => {
          const active = r.status === 'queued' || r.status === 'running';
          if (active && r.progress) {
            const { phase, done, total } = r.progress;
            const count = typeof total === 'number' && total > 0 ? ` ${done ?? 0}/${total}` : '';
            return <span className={styles.muted}>{phase}{count}</span>;
          }
          return <TotalsInline totals={r.totals} />;
        },
        compare: (a, b) => {
          const aTotal = a.totals ? a.totals.passed + a.totals.failed + a.totals.skipped : 0;
          const bTotal = b.totals ? b.totals.passed + b.totals.failed + b.totals.skipped : 0;
          return aTotal - bTotal;
        },
      }),
      createTableColumn<Run>({
        columnId: 'started',
        renderHeaderCell: () => 'Started',
        renderCell: (r) => (
          <span className={styles.muted}>{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</span>
        ),
        compare: (a, b) => {
          const aTime = a.started_at ? new Date(a.started_at).getTime() : 0;
          const bTime = b.started_at ? new Date(b.started_at).getTime() : 0;
          return aTime - bTime;
        },
      }),
      createTableColumn<Run>({
        columnId: 'duration',
        renderHeaderCell: () => 'Duration',
        renderCell: (r) => <Mono>{formatDurationRange(r.started_at, r.ended_at)}</Mono>,
        compare: (a, b) => {
          const aDur = a.started_at && a.ended_at
            ? new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()
            : 0;
          const bDur = b.started_at && b.ended_at
            ? new Date(b.ended_at).getTime() - new Date(b.started_at).getTime()
            : 0;
          return aDur - bDur;
        },
      }),
    ],
    [styles],
  );

  return (
    <div className={styles.page}>
      <div className={styles.title}>Test runs</div>
      <div className={styles.subtitle}>
        Deterministic suite runs against deployed targets. Flaky failures are quarantined;
        genuine failures are clustered into bundles.
      </div>
      {isLoading ? (
        <div className={styles.gridWrap} style={{ padding: '32px' }}>
          Loading runs…
        </div>
      ) : !runs || runs.length === 0 ? (
        <EmptyState message="No runs yet — start one from New run." />
      ) : (
        <div className={styles.gridWrap}>
          <DataGrid
            items={runs}
            columns={columns}
            getRowId={(item) => item.id}
            size="small"
            sortable
            sortState={sortState}
            onSortChange={(_e, nextState) => setSortState(nextState)}
          >
            <DataGridHeader>
              <DataGridRow>
                {({ renderHeaderCell }) => (
                  <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                )}
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody<Run>>
              {({ item, rowId }) => (
                <DataGridRow<Run>
                  key={rowId}
                  className={styles.row}
                  onClick={() => navigate(`/runs/${item.id}`)}
                >
                  {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                </DataGridRow>
              )}
            </DataGridBody>
          </DataGrid>
        </div>
      )}
    </div>
  );
}
