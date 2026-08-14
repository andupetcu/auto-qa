import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular, Eye20Regular, EyeOff20Regular } from '@fluentui/react-icons';

import { endpoints } from '../api/endpoints';
import type { Project, ProjectCreateInput, ProjectRole } from '../api/types';
import { monoFontFamily } from '../components/MonoBlock';

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
  credentialsBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    backgroundColor: '#191919',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  credTitle: {
    fontSize: '12px',
    fontWeight: 600,
  },
  credNote: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground4,
    lineHeight: 1.5,
  },
  credState: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
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

function routesToText(project: Project | null): string {
  // routes aren't returned verbatim by GET /projects (only routes_count);
  // an empty textarea with the ALL sentinel is the safe default for edits.
  return project ? 'ALL' : '/\n/reports\n/reports/:id';
}

function parseRoutes(text: string): string[] | 'ALL' {
  const trimmed = text.trim();
  if (trimmed.toUpperCase() === 'ALL' || trimmed.length === 0) return 'ALL';
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function rolesToText(roles: ProjectRole[]): string {
  return roles.map((r) => r.name).join(', ');
}

function parseRoles(text: string, existing: ProjectRole[]): ProjectRole[] {
  const names = text
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return [{ name: 'user' }, { name: 'anon' }];
  return names.map((name) => {
    const match = existing.find((r) => r.name === name);
    return match ?? { name };
  });
}

export function ProjectDrawer({
  open,
  project,
  isNew,
  onClose,
}: {
  open: boolean;
  project: Project | null;
  isNew: boolean;
  onClose: () => void;
}) {
  const styles = useStyles();
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [routesText, setRoutesText] = useState('/\n/reports\n/reports/:id');
  const [rolesText, setRolesText] = useState('user, anon');
  const [cron, setCron] = useState('');
  const [maxParallel, setMaxParallel] = useState(2);
  const [credUser, setCredUser] = useState('');
  const [credPass, setCredPass] = useState('');
  const [credTotp, setCredTotp] = useState('');
  const [showPass, setShowPass] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (project) {
      setName(project.name);
      setBaseUrl(project.base_url_default);
      setRoutesText(routesToText(project));
      setRolesText(rolesToText(project.roles));
      setCron(project.schedule_cron ?? '');
      setMaxParallel(project.max_parallel);
    } else {
      setName('');
      setBaseUrl('https://');
      setRoutesText('/\n/reports\n/reports/:id');
      setRolesText('user, anon');
      setCron('');
      setMaxParallel(2);
    }
    setCredUser('');
    setCredPass('');
    setCredTotp('');
    setShowPass(false);
  }, [open, project]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const routes = parseRoutes(routesText);
      const roles = parseRoles(rolesText, project?.roles ?? []);
      const payload: ProjectCreateInput = {
        name,
        base_url_default: baseUrl,
        roles,
        routes: routes === 'ALL' ? undefined : routes,
        schedule_cron: cron.trim() || null,
        max_parallel: maxParallel,
      };
      if (isNew) {
        return endpoints.createProject(payload);
      }
      return endpoints.patchProject((project as Project).name, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
  });

  const credentialsMutation = useMutation({
    mutationFn: () =>
      endpoints.putProjectCredentials((project as Project).name, {
        username: credUser,
        password: credPass,
        totp_seed: credTotp.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCredUser('');
      setCredPass('');
      setCredTotp('');
    },
  });

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
          {isNew ? 'New project' : `Edit ${project?.name ?? ''}`}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>
        <Field label="Name">
          <Input
            value={name}
            onChange={(_, data) => setName(data.value)}
            placeholder="e.g. Retailer tenant 51"
          />
        </Field>
        <Field label="Base URL">
          <Input
            className={styles.mono}
            value={baseUrl}
            onChange={(_, data) => setBaseUrl(data.value)}
            spellCheck={false}
          />
        </Field>
        <Field label="Routes" hint="One per line, merged with discovery. Use ALL for every discovered route.">
          <Textarea
            className={styles.mono}
            value={routesText}
            onChange={(_, data) => setRoutesText(data.value)}
            rows={6}
            spellCheck={false}
          />
        </Field>
        <Field label="Roles" hint="Comma-separated role names.">
          <Input value={rolesText} onChange={(_, data) => setRolesText(data.value)} />
        </Field>

        <div className={styles.credentialsBox}>
          <div className={styles.credTitle}>Credentials &mdash; role user</div>
          <div className={styles.credState}>
            current: {project?.credentials.username ?? 'none'} &middot;{' '}
            {project?.credentials.has_password ? 'password set' : 'no password'} &middot;{' '}
            {project?.credentials.has_totp ? 'TOTP set' : 'no TOTP'}
          </div>
          <Field label="Username / email">
            <Input
              className={styles.mono}
              value={credUser}
              onChange={(_, data) => setCredUser(data.value)}
              placeholder="qa-account@footprints.media"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Password">
            <Input
              className={styles.mono}
              type={showPass ? 'text' : 'password'}
              value={credPass}
              onChange={(_, data) => setCredPass(data.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              contentAfter={
                <Button
                  appearance="transparent"
                  size="small"
                  icon={showPass ? <EyeOff20Regular /> : <Eye20Regular />}
                  onClick={() => setShowPass((v) => !v)}
                  aria-label={showPass ? 'Hide password' : 'Show password'}
                />
              }
            />
          </Field>
          <Field label="TOTP secret" hint="Optional — 2FA-enabled projects.">
            <Input
              className={styles.mono}
              value={credTotp}
              onChange={(_, data) => setCredTotp(data.value)}
              placeholder="base32 seed, e.g. JBSWY3DPEHPK3PXP"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className={styles.credNote}>
            Stored write-only in the encrypted secrets file, injected as env vars at session
            mint. Never persisted in the DB, never returned by the API. Test accounts only.
          </div>
          <Button
            onClick={() => credentialsMutation.mutate()}
            disabled={!project || !credUser || !credPass || credentialsMutation.isPending}
          >
            Save credentials
          </Button>
        </div>

        <Field label="Recurring schedule" hint="Cron expression; leave blank for manual only.">
          <Input
            className={styles.mono}
            value={cron}
            onChange={(_, data) => setCron(data.value)}
            placeholder="0 6 * * *"
            spellCheck={false}
          />
        </Field>
        <Field label="Max parallel browser contexts">
          <Input
            type="number"
            min={1}
            max={16}
            value={String(maxParallel)}
            onChange={(_, data) => setMaxParallel(Number(data.value) || 1)}
          />
        </Field>
      </DrawerBody>
      <div className={styles.footer}>
        <Button
          appearance="primary"
          onClick={() => saveMutation.mutate()}
          disabled={!name || !baseUrl || saveMutation.isPending}
        >
          Save project
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </Drawer>
  );
}
