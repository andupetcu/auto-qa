import { makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  box: {
    marginTop: '20px',
    padding: '32px',
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
});

export function EmptyState({ message }: { message: string }) {
  const styles = useStyles();
  return <div className={styles.box}>{message}</div>;
}
