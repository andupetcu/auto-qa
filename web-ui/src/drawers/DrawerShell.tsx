import type { ReactNode } from 'react';
import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Button,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';

const useStyles = makeStyles({
  drawer: {
    width: '640px',
    maxWidth: '92vw',
  },
  header: {
    position: 'sticky',
    top: 0,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    width: '100%',
  },
  spacer: { flex: 1 },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    paddingBottom: '20px',
  },
  sectionLabel: {
    fontSize: '11px',
    fontWeight: 700,
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.6px',
    marginBottom: '6px',
  },
});

export function useDrawerStyles() {
  return useStyles();
}

export function DrawerShell({
  open,
  onClose,
  titleContent,
  children,
}: {
  open: boolean;
  onClose: () => void;
  titleContent: ReactNode;
  children: ReactNode;
}) {
  const styles = useStyles();
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
      <DrawerHeader className={styles.header}>
        <DrawerHeaderTitle
          action={
            <Button
              appearance="subtle"
              icon={<Dismiss24Regular />}
              onClick={onClose}
              aria-label="Close"
            />
          }
        >
          <div className={styles.titleRow}>{titleContent}</div>
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody className={styles.body}>{children}</DrawerBody>
    </Drawer>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <div className={styles.sectionLabel}>{children}</div>;
}
