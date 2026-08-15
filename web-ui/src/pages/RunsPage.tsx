/** @fileoverview Paginated run history with live status refresh. */

import { useMemo } from 'react';
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
      }),
      createTableColumn<Run>({
        columnId: 'status',
        renderHeaderCell: () => 'Status',
        renderCell: (r) => <RunStatusBadge status={r.status} />,
      }),
      createTableColumn<Run>({
        columnId: 'trigger',
        renderHeaderCell: () => 'Trigger',
        renderCell: (r) => <span className={styles.muted}>{r.trigger}</span>,
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
      }),
      createTableColumn<Run>({
        columnId: 'started',
        renderHeaderCell: () => 'Started',
        renderCell: (r) => (
          <span className={styles.muted}>{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</span>
        ),
      }),
      createTableColumn<Run>({
        columnId: 'duration',
        renderHeaderCell: () => 'Duration',
        renderCell: (r) => <Mono>{formatDurationRange(r.started_at, r.ended_at)}</Mono>,
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
