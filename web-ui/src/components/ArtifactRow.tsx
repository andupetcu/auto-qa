import { makeStyles, tokens } from '@fluentui/react-components';
import { monoFontFamily } from './MonoBlock';
import type { ArtifactType, SignedArtifact } from '../api/types';

const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
  trace: 'trace.zip',
  har: 'network.har',
  video: 'video.webm',
  frames: 'frames.zip',
  sheet: 'sheet.csv',
  screenshot: 'failure.png',
  console: 'console.jsonl',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const useStyles = makeStyles({
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '9px 14px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  type: {
    width: '70px',
    flexShrink: 0,
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontFamily: monoFontFamily,
    fontSize: '12px',
    color: tokens.colorNeutralForeground1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  bytes: {
    fontFamily: monoFontFamily,
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  link: {
    fontSize: '12px',
    fontWeight: 600,
  },
});

export function ArtifactRow({ artifact }: { artifact: SignedArtifact }) {
  const styles = useStyles();
  return (
    <div className={styles.row}>
      <span className={styles.type}>{artifact.type}</span>
      <span className={styles.name}>{ARTIFACT_FILENAMES[artifact.type] ?? artifact.type}</span>
      <span className={styles.bytes}>{formatBytes(artifact.bytes)}</span>
      <a
        className={styles.link}
        href={artifact.url}
        target="_blank"
        rel="noreferrer noopener"
      >
        Open &#8599;
      </a>
    </div>
  );
}
