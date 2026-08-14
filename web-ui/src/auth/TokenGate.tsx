import { useSyncExternalStore, useState, type FormEvent } from 'react';
import {
  Button,
  Field,
  Input,
  Title3,
  Body1,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { authStore } from './authStore';

const useStyles = makeStyles({
  page: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    width: '100vw',
    backgroundColor: tokens.colorNeutralBackground1,
  },
  card: {
    width: '360px',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalXXL,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  brandRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  logo: {
    width: '24px',
    height: '24px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorBrandBackground,
    display: 'grid',
    placeItems: 'center',
    fontSize: '12px',
    fontWeight: 700,
    color: '#fff',
  },
  rejected: {
    color: tokens.colorPaletteRedForeground1,
  },
});

export function useAuthToken(): string | null {
  return useSyncExternalStore(authStore.subscribe, authStore.getToken);
}

export function TokenGate({ children }: { children: React.ReactNode }) {
  const token = useAuthToken();
  const rejected = useSyncExternalStore(authStore.subscribe, authStore.isRejected);
  const styles = useStyles();
  const [value, setValue] = useState('');

  if (token) {
    return <>{children}</>;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    authStore.setToken(trimmed);
  }

  return (
    <div className={styles.page}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.brandRow}>
          <div className={styles.logo}>Q</div>
          <Title3>Auto QA</Title3>
        </div>
        <Body1>Enter the API bearer token to connect to the control plane.</Body1>
        <Field
          label="API token"
          validationState={rejected ? 'error' : 'none'}
          validationMessage={rejected ? 'Token rejected' : undefined}
        >
          <Input
            type="password"
            autoFocus
            value={value}
            onChange={(_, data) => setValue(data.value)}
            placeholder="qa_..."
          />
        </Field>
        <Button appearance="primary" type="submit" disabled={!value.trim()}>
          Connect
        </Button>
        {rejected ? (
          <Text size={200} className={styles.rejected}>
            The previous token was rejected by the server. Enter a valid token to continue.
          </Text>
        ) : null}
      </form>
    </div>
  );
}
