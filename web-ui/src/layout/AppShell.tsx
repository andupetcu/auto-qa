import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button,
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { Play20Filled } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';

import { endpoints } from '../api/endpoints';
import { registerToastHandler } from '../api/toastBridge';
import { monoFontFamily } from '../components/MonoBlock';
import { COLOR } from '../components/statusMeta';
import { NewRunDrawer } from '../drawers/NewRunDrawer';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    height: '48px',
    padding: '0 16px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    flexShrink: 0,
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  logo: {
    width: '20px',
    height: '20px',
    borderRadius: '4px',
    backgroundColor: tokens.colorBrandBackground,
    display: 'grid',
    placeItems: 'center',
    fontSize: '11px',
    fontWeight: 700,
    color: '#fff',
  },
  title: {
    fontSize: '14px',
    fontWeight: 600,
  },
  divider: {
    width: '1px',
    height: '20px',
    backgroundColor: tokens.colorNeutralStroke1,
  },
  pill: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 10px',
    borderRadius: '9999px',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: monoFontFamily,
    fontSize: '11px',
    color: tokens.colorNeutralForeground2,
  },
  dot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    flexShrink: 0,
  },
  spacer: { flex: 1 },
  versionText: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  body: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
  },
  nav: {
    width: '200px',
    flexShrink: 0,
    backgroundColor: tokens.colorNeutralBackground1,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '34px',
    padding: '0 10px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    ':hover': {
      backgroundColor: tokens.colorNeutralBackground3Hover,
    },
  },
  navBar: {
    width: '3px',
    height: '16px',
    borderRadius: '2px',
    flexShrink: 0,
  },
  navSpacer: { flex: 1 },
  navFooter: {
    padding: '10px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    lineHeight: 1.6,
    fontFamily: monoFontFamily,
  },
  content: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
  },
});

const NAV_ITEMS = [
  { path: '/runs', label: 'Runs' },
  { path: '/projects', label: 'Projects' },
  { path: '/matrix', label: 'Routes & matrix' },
  { path: '/coverage', label: 'Coverage & flake' },
];

export function AppShell() {
  const styles = useStyles();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toasterId = useId('toaster');
  const { dispatchToast } = useToastController(toasterId);

  const capabilities = useQuery({
    queryKey: ['capabilities'],
    queryFn: endpoints.capabilities,
    retry: 0,
  });

  useEffect(() => {
    registerToastHandler((title, detail) => {
      dispatchToast(
        <Toast>
          <ToastTitle>{title}</ToastTitle>
          <ToastBody>{detail}</ToastBody>
        </Toast>,
        { intent: 'error' },
      );
    });
    return () => registerToastHandler(null);
  }, [dispatchToast]);

  const newRunOpen = searchParams.get('newRun') === '1';
  const openNewRun = () => {
    const next = new URLSearchParams(searchParams);
    next.set('newRun', '1');
    setSearchParams(next);
  };
  const closeNewRun = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('newRun');
    setSearchParams(next);
  };

  const connectionColor = capabilities.isError
    ? COLOR.failed
    : capabilities.isSuccess
      ? COLOR.passed
      : COLOR.neutral;

  return (
    <div className={styles.root}>
      <Toaster toasterId={toasterId} />
      <div className={styles.header}>
        <div className={styles.brand}>
          <div className={styles.logo}>Q</div>
          <div className={styles.title}>Auto QA</div>
        </div>
        <div className={styles.divider} />
        <div className={styles.pill}>
          <span className={styles.dot} style={{ backgroundColor: connectionColor }} />
          {capabilities.isSuccess ? `v${capabilities.data.version}` : 'control plane'}
        </div>
        <div className={styles.spacer} />
        <div className={styles.versionText}>deterministic only &middot; no LLM calls</div>
        <Button appearance="primary" icon={<Play20Filled />} onClick={openNewRun}>
          New run
        </Button>
      </div>
      <div className={styles.body}>
        <div className={styles.nav}>
          {NAV_ITEMS.map((item) => {
            const active =
              location.pathname === item.path ||
              (item.path === '/runs' && location.pathname.startsWith('/runs/'));
            return (
              <div
                key={item.path}
                className={styles.navItem}
                style={{
                  backgroundColor: active ? tokens.colorNeutralBackground3 : 'transparent',
                  color: active ? tokens.colorNeutralForeground1 : tokens.colorNeutralForeground2,
                  fontWeight: active ? 600 : 400,
                }}
                onClick={() => navigate(item.path)}
              >
                <span
                  className={styles.navBar}
                  style={{ backgroundColor: active ? COLOR.brand : 'transparent' }}
                />
                {item.label}
              </div>
            );
          })}
          <div className={styles.navSpacer} />
          <div className={styles.navFooter}>
            control plane
            <br />
            /api/v1
            <br />
            <span style={{ color: connectionColor }}>
              &#9679; {capabilities.isSuccess ? 'connected' : capabilities.isError ? 'unreachable' : 'connecting…'}
            </span>
          </div>
        </div>
        <div className={styles.content}>
          <Outlet />
        </div>
      </div>
      <NewRunDrawer open={newRunOpen} onClose={closeNewRun} />
    </div>
  );
}
