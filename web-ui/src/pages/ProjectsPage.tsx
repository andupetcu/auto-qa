import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Switch, makeStyles, tokens } from '@fluentui/react-components';
import { Play20Filled } from '@fluentui/react-icons';

import { endpoints } from '../api/endpoints';
import type { Project, Run } from '../api/types';
import { Mono } from '../components/MonoBlock';
import { RunStatusBadge } from '../components/StatusBadge';
import { EmptyState } from '../components/EmptyState';
import { ProjectDrawer } from '../drawers/ProjectDrawer';

const useStyles = makeStyles({
  page: {
    padding: '24px',
    maxWidth: '1100px',
  },
  topRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
  },
  title: {
    fontSize: '20px',
    fontWeight: 600,
  },
  subtitle: {
    marginTop: '4px',
    color: tokens.colorNeutralForeground3,
  },
  cardsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    marginTop: '20px',
  },
  card: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    padding: '16px',
  },
  cardHeaderRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  name: {
    fontSize: '15px',
    fontWeight: 600,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  switchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  switchLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  baseUrl: {
    marginTop: '6px',
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  chipRow: {
    display: 'flex',
    gap: '8px',
    marginTop: '12px',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  chip: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
  },
  monoChip: {
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
  },
  totpOn: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: 'rgba(84,176,84,0.12)',
    border: '1px solid rgba(84,176,84,0.35)',
    color: '#54b054',
    whiteSpace: 'nowrap',
  },
  totpOff: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  schedChip: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: 'rgba(71,158,245,0.10)',
    border: '1px solid rgba(71,158,245,0.3)',
    color: '#479ef5',
    whiteSpace: 'nowrap',
  },
  lastRunRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginTop: '12px',
    paddingTop: '12px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  lastRunLabel: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  lastRunWhen: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
});

function timeUntil(iso: string | null): string {
  if (!iso) return '';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'due now';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `next in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `next in ${hours}h ${rem}m`;
}

export function ProjectsPage() {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: endpoints.projects });
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: () => endpoints.runs({ limit: 50 }) });

  const lastRunByProject = useMemo(() => {
    const map = new Map<string, Run>();
    for (const run of runsQuery.data ?? []) {
      if (!map.has(run.project)) map.set(run.project, run);
    }
    return map;
  }, [runsQuery.data]);

  const toggleEnabled = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      endpoints.patchProject(name, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const runNow = useMutation({
    mutationFn: (name: string) => endpoints.runProject(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });

  const runAllEnabled = useMutation({
    mutationFn: async () => {
      const enabled = (projectsQuery.data ?? []).filter((p) => p.enabled);
      await Promise.all(enabled.map((p) => endpoints.runProject(p.name)));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });

  const editParam = searchParams.get('project');

  function openNewProject() {
    const next = new URLSearchParams(searchParams);
    next.set('project', 'new');
    setSearchParams(next);
  }
  function openEditProject(name: string) {
    const next = new URLSearchParams(searchParams);
    next.set('project', name);
    setSearchParams(next);
  }
  function closeDrawer() {
    const next = new URLSearchParams(searchParams);
    next.delete('project');
    setSearchParams(next);
  }

  const editingProject =
    editParam && editParam !== 'new'
      ? projectsQuery.data?.find((p) => p.name === editParam) ?? null
      : null;

  return (
    <div className={styles.page}>
      <div className={styles.topRow}>
        <div style={{ flex: 1 }}>
          <div className={styles.title}>Projects</div>
          <div className={styles.subtitle}>
            Per-project targets, routes, credentials and schedules. Projects run in parallel
            &mdash; each gets its own worker contexts.
          </div>
        </div>
        <Button onClick={() => runAllEnabled.mutate()} disabled={runAllEnabled.isPending}>
          &#9654; Run all enabled
        </Button>
        <Button appearance="primary" onClick={openNewProject}>
          + New project
        </Button>
      </div>

      {projectsQuery.isLoading ? (
        <div style={{ marginTop: '20px' }}>Loading projects&hellip;</div>
      ) : !projectsQuery.data || projectsQuery.data.length === 0 ? (
        <EmptyState message="No projects yet — create one to start running the suite." />
      ) : (
        <div className={styles.cardsList}>
          {projectsQuery.data.map((p: Project) => {
            const lastRun = lastRunByProject.get(p.name);
            return (
              <div key={p.id} className={styles.card} style={{ opacity: p.enabled ? 1 : 0.6 }}>
                <div className={styles.cardHeaderRow}>
                  <div className={styles.name}>{p.name}</div>
                  <div className={styles.switchRow}>
                    <span className={styles.switchLabel}>{p.enabled ? 'enabled' : 'disabled'}</span>
                    <Switch
                      checked={p.enabled}
                      onChange={(_, data) =>
                        toggleEnabled.mutate({ name: p.name, enabled: data.checked })
                      }
                    />
                  </div>
                  <Button size="small" onClick={() => openEditProject(p.name)}>
                    Edit
                  </Button>
                  <Button
                    size="small"
                    appearance="primary"
                    icon={<Play20Filled />}
                    onClick={() => runNow.mutate(p.name)}
                    disabled={runNow.isPending || !p.enabled}
                  >
                    Run now
                  </Button>
                </div>
                <div className={styles.baseUrl}>{p.base_url_default}</div>
                <div className={styles.chipRow}>
                  <span className={styles.chip}>{p.routes_count} routes</span>
                  <span className={styles.chip}>roles: {p.roles.map((r) => r.name).join(', ')}</span>
                  {p.credentials.username ? (
                    <span className={`${styles.chip} ${styles.monoChip}`}>
                      {p.credentials.username}
                    </span>
                  ) : (
                    <span className={styles.chip}>no credentials</span>
                  )}
                  <span className={p.credentials.has_totp ? styles.totpOn : styles.totpOff}>
                    {p.credentials.has_totp ? '2FA · TOTP' : 'no 2FA'}
                  </span>
                  <span className={styles.schedChip}>
                    <Mono>{p.schedule_cron ?? 'manual only'}</Mono>
                    {p.schedule_cron ? ` · ${timeUntil(p.next_run_at)}` : ''}
                  </span>
                  <span className={styles.chip}>{p.max_parallel} parallel</span>
                </div>
                {lastRun ? (
                  <div className={styles.lastRunRow}>
                    <span className={styles.lastRunLabel}>last run</span>
                    <RunStatusBadge status={lastRun.status} />
                    <span className={styles.lastRunWhen}>
                      {new Date(lastRun.started_at).toLocaleString()}
                    </span>
                    <Mono>
                      {lastRun.totals
                        ? `${lastRun.totals.passed} ✓ ${lastRun.totals.failed} ✗ ${lastRun.totals.flaky} ~`
                        : '—'}
                    </Mono>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <ProjectDrawer
        open={Boolean(editParam)}
        project={editingProject}
        isNew={editParam === 'new'}
        onClose={closeDrawer}
      />
    </div>
  );
}
