import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';

import { endpoints } from '../api/endpoints';
import type { RunCreateInput } from '../api/types';
import { monoFontFamily } from '../components/MonoBlock';

// Fallbacks used only until GET /capabilities loads (the control plane is the source
// of truth for the offered browsers/viewports).
const BROWSERS_FALLBACK = ['chromium', 'firefox', 'webkit'];
const VIEWPORTS_FALLBACK = ['1440x900', '1280x720', '390x844'];

const useStyles = makeStyles({
  drawer: {
    width: '420px',
    maxWidth: '92vw',
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    paddingBottom: '20px',
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  chip: {
    padding: '4px 12px',
    borderRadius: '9999px',
    fontSize: '12px',
    cursor: 'pointer',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    userSelect: 'none',
  },
  chipSelected: {
    backgroundColor: 'rgba(71,158,245,0.15)',
    border: '1px solid #479ef5',
    color: '#479ef5',
  },
  monoChip: {
    fontFamily: monoFontFamily,
  },
  summary: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '10px 12px',
    lineHeight: 1.6,
  },
  footer: {
    display: 'flex',
    gap: '8px',
    padding: '14px 20px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mono: {
    fontFamily: monoFontFamily,
  },
});

function toggleSet<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function NewRunDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const styles = useStyles();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [projectName, setProjectName] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [routesAll, setRoutesAll] = useState(true);
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Set<string>>(new Set(['user', 'anon']));
  const [browsers, setBrowsers] = useState<Set<string>>(new Set(['chromium']));
  const [viewports, setViewports] = useState<Set<string>>(new Set(['1440x900']));
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: endpoints.projects,
    enabled: open,
  });
  const capabilitiesQuery = useQuery({
    queryKey: ['capabilities'],
    queryFn: endpoints.capabilities,
    enabled: open,
  });
  const browserOptions = capabilitiesQuery.data?.browsers ?? BROWSERS_FALLBACK;
  const viewportOptions = capabilitiesQuery.data?.viewports ?? VIEWPORTS_FALLBACK;
  const routesQuery = useQuery({
    queryKey: ['routes', projectName],
    queryFn: () => endpoints.routes(projectName ?? undefined),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setIdempotencyKey(crypto.randomUUID());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const project = projectsQuery.data?.find((p) => p.name === projectName);
    if (project) {
      setBaseUrl(project.base_url_default);
      setRoles(new Set(project.roles.map((r) => r.name)));
    }
  }, [projectName, projectsQuery.data, open]);

  useEffect(() => {
    if (open && !projectName && projectsQuery.data && projectsQuery.data.length > 0) {
      setProjectName(projectsQuery.data[0].name);
    }
  }, [open, projectName, projectsQuery.data]);

  const routePaths = useMemo(
    () => Array.from(new Set((routesQuery.data ?? []).map((r) => r.path))),
    [routesQuery.data],
  );

  const createMutation = useMutation({
    mutationFn: () => {
      const input: RunCreateInput = {
        routes: routesAll ? 'ALL' : Array.from(selectedRoutes),
        project: projectName ?? undefined,
        roles: Array.from(roles),
        browsers: Array.from(browsers),
        viewports: Array.from(viewports),
        base_url: baseUrl || undefined,
        app_version: appVersion || undefined,
      };
      return endpoints.createRun(input, idempotencyKey);
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      onClose();
      navigate(`/runs/${res.run_id}`);
    },
  });

  const summary = `${routesAll ? 'ALL routes' : `${selectedRoutes.size} route(s)`} · ${
    roles.size
  } role(s) · ${browsers.size} browser(s) · ${viewports.size} viewport(s)`;

  return (
    <Drawer
      type="overlay"
      position="end"
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
      className={styles.drawer}
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button appearance="subtle" icon={<Dismiss24Regular />} onClick={onClose} aria-label="Close" />
          }
        >
          New suite run
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        <Field label="Project">
          <div className={styles.chipRow}>
            {(projectsQuery.data ?? []).map((p) => (
              <span
                key={p.name}
                className={`${styles.chip} ${projectName === p.name ? styles.chipSelected : ''}`}
                onClick={() => setProjectName(p.name)}
              >
                {p.name}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Target base URL">
          <Input
            className={styles.mono}
            value={baseUrl}
            onChange={(_, data) => setBaseUrl(data.value)}
            spellCheck={false}
          />
        </Field>
        <Field label="App version" hint="Advisory">
          <Input
            className={styles.mono}
            value={appVersion}
            onChange={(_, data) => setAppVersion(data.value)}
            placeholder="e.g. 2026.08.14-rc2"
            spellCheck={false}
          />
        </Field>
        <Field label="Routes">
          <div className={styles.chipRow}>
            <span
              className={`${styles.chip} ${routesAll ? styles.chipSelected : ''}`}
              style={{ fontWeight: 600 }}
              onClick={() => setRoutesAll((v) => !v)}
            >
              ALL
            </span>
            {routePaths.map((path) => (
              <span
                key={path}
                className={`${styles.chip} ${styles.monoChip} ${
                  !routesAll && selectedRoutes.has(path) ? styles.chipSelected : ''
                }`}
                style={{ opacity: routesAll ? 0.5 : 1 }}
                onClick={() => setSelectedRoutes((s) => toggleSet(s, path))}
              >
                {path}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Roles">
          <div className={styles.chipRow}>
            {['user', 'anon'].map((role) => (
              <span
                key={role}
                className={`${styles.chip} ${roles.has(role) ? styles.chipSelected : ''}`}
                onClick={() => setRoles((s) => toggleSet(s, role))}
              >
                {role}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Browsers">
          <div className={styles.chipRow}>
            {browserOptions.map((b) => (
              <span
                key={b}
                className={`${styles.chip} ${browsers.has(b) ? styles.chipSelected : ''}`}
                onClick={() => setBrowsers((s) => toggleSet(s, b))}
              >
                {b}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Viewports">
          <div className={styles.chipRow}>
            {viewportOptions.map((v) => (
              <span
                key={v}
                className={`${styles.chip} ${styles.monoChip} ${
                  viewports.has(v) ? styles.chipSelected : ''
                }`}
                onClick={() => setViewports((s) => toggleSet(s, v))}
              >
                {v}
              </span>
            ))}
          </div>
        </Field>
        <div className={styles.summary}>
          {summary} &middot; flake reruns &times;3 &middot; trace, HAR &amp; console captured per
          test
        </div>
      </DrawerBody>
      <div className={styles.footer}>
        <Button
          appearance="primary"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || (!routesAll && selectedRoutes.size === 0)}
        >
          Start run
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Drawer>
  );
}
