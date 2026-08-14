import { makeStyles, tokens } from '@fluentui/react-components';

import type { ArtifactType, FailureBundle } from '../api/types';
import { SeverityBadge } from '../components/SeverityBadge';
import { Mono, MonoBlock } from '../components/MonoBlock';
import { DrawerShell, SectionLabel } from './DrawerShell';

const ARTIFACT_FILENAMES: Record<ArtifactType, string> = {
  trace: 'trace.zip',
  har: 'network.har',
  video: 'video.webm',
  frames: 'frames.zip',
  sheet: 'sheet.csv',
  screenshot: 'failure.png',
  console: 'console.jsonl',
};

const useStyles = makeStyles({
  idText: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  title: {
    fontSize: '16px',
    fontWeight: 600,
  },
  file: {
    marginTop: '4px',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  chipRow: {
    display: 'flex',
    gap: '8px',
    marginTop: '10px',
    flexWrap: 'wrap',
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
  affectedChip: {
    padding: '2px 8px',
    borderRadius: '9999px',
    fontSize: '11px',
    backgroundColor: 'rgba(71,158,245,0.10)',
    border: '1px solid rgba(71,158,245,0.3)',
    color: '#479ef5',
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    whiteSpace: 'nowrap',
  },
  entryList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  consoleEntry: {
    backgroundColor: '#161616',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderLeft: '3px solid #dc626d',
    borderRadius: tokens.borderRadiusMedium,
    padding: '10px 12px',
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
  },
  consoleText: {
    color: '#f1707b',
    whiteSpace: 'pre-wrap',
  },
  consoleSource: {
    marginTop: '4px',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
  },
  networkEntry: {
    backgroundColor: '#161616',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '10px 12px',
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
  },
  networkHead: {
    display: 'flex',
    gap: '10px',
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  networkSnippet: {
    marginTop: '4px',
    color: '#b09292',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  screenshotBox: {
    height: '240px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
  },
  screenshotImg: {
    maxWidth: '100%',
    maxHeight: '100%',
    display: 'block',
  },
  artifactList: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  artifactRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '9px 14px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  artifactType: {
    width: '70px',
    flexShrink: 0,
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
  },
  artifactName: {
    flex: 1,
    minWidth: 0,
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  expiryNote: {
    marginTop: '8px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground4,
  },
});

export function BundleDrawer({
  bundle,
  open,
  onClose,
}: {
  bundle: FailureBundle | null;
  open: boolean;
  onClose: () => void;
}) {
  const styles = useStyles();

  if (!bundle) {
    return <DrawerShell open={open} onClose={onClose} titleContent={null} children={null} />;
  }

  const artifactEntries = Object.entries(bundle.artifacts) as [ArtifactType, string][];

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      titleContent={
        <>
          <SeverityBadge severity={bundle.severity} />
          <span className={styles.idText}>
            <Mono>
              {bundle.bundle_id} &middot; {bundle.cluster_id}
            </Mono>
          </span>
        </>
      }
    >
      <div>
        <div className={styles.title}>{bundle.test.name}</div>
        <div className={styles.file}>
          <Mono>{bundle.test.file}</Mono>
        </div>
        <div className={styles.chipRow}>
          <span className={styles.chip}>{bundle.occurrences} occurrences</span>
          <span className={styles.chip}>
            reruns {bundle.test.reruns_attempted} attempted &middot; {bundle.test.reruns_failed} failed
          </span>
          {bundle.affected.map((a, i) => (
            <span key={i} className={styles.affectedChip}>
              {a.route} &middot; {a.role}
            </span>
          ))}
        </div>
      </div>

      <div>
        <SectionLabel>Failed action</SectionLabel>
        {bundle.failed_action ? (
          <MonoBlock>
            <div style={{ color: tokens.colorNeutralForeground1 }}>{bundle.failed_action.step}</div>
            <div style={{ color: '#dc626d', marginTop: '6px' }}>{bundle.failed_action.error}</div>
            {bundle.failed_action.actual ? (
              <div style={{ color: tokens.colorNeutralForeground3, marginTop: '6px' }}>
                actual: {bundle.failed_action.actual}
              </div>
            ) : null}
          </MonoBlock>
        ) : (
          <div className={styles.file}>No failed action recorded.</div>
        )}
      </div>

      <div>
        <SectionLabel>
          Console errors <span style={{ fontWeight: 400 }}>&mdash; deduped, top 20</span>
        </SectionLabel>
        {bundle.console_errors.length === 0 ? (
          <div className={styles.file}>No console errors captured.</div>
        ) : (
          <div className={styles.entryList}>
            {bundle.console_errors.map((c, i) => (
              <div key={i} className={styles.consoleEntry}>
                <div className={styles.consoleText}>{c.text}</div>
                <div className={styles.consoleSource}>
                  {c.source} &middot; &times;{c.count}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionLabel>
          Network failures{' '}
          <span style={{ fontWeight: 400 }}>&mdash; &ge;400 / failed / slow, bodies truncated to 512 B</span>
        </SectionLabel>
        {bundle.network_failures.length === 0 ? (
          <div className={styles.file}>No network failures captured.</div>
        ) : (
          <div className={styles.entryList}>
            {bundle.network_failures.map((n, i) => (
              <div key={i} className={styles.networkEntry}>
                <div className={styles.networkHead}>
                  <span style={{ fontWeight: 700 }}>{n.method}</span>
                  <span style={{ wordBreak: 'break-all' }}>{n.url_path}</span>
                  <span style={{ color: '#dc626d', fontWeight: 700 }}>{n.status}</span>
                  <span style={{ color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' }}>
                    {n.timing_ms} ms
                  </span>
                </div>
                <div className={styles.networkSnippet}>{n.resp_snippet}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <SectionLabel>DOM excerpt</SectionLabel>
        <MonoBlock color="#8ab4e8">{bundle.dom_excerpt}</MonoBlock>
      </div>

      {bundle.artifacts.screenshot ? (
        <div>
          <SectionLabel>Failure screenshot</SectionLabel>
          <div className={styles.screenshotBox}>
            <img className={styles.screenshotImg} src={bundle.artifacts.screenshot} alt="Failure screenshot" />
          </div>
        </div>
      ) : null}

      <div>
        <SectionLabel>
          Artifacts <span style={{ fontWeight: 400 }}>&mdash; signed URLs, expire {bundle.artifact_expiry}</span>
        </SectionLabel>
        <div className={styles.artifactList}>
          {artifactEntries.length === 0 ? (
            <div className={styles.file}>No artifacts captured.</div>
          ) : (
            artifactEntries.map(([type, url]) => (
              <div key={type} className={styles.artifactRow}>
                <span className={styles.artifactType}>{type}</span>
                <span className={styles.artifactName}>{ARTIFACT_FILENAMES[type] ?? type}</span>
                <a href={url} target="_blank" rel="noreferrer noopener" style={{ fontSize: '12px', fontWeight: 600 }}>
                  Open &#8599;
                </a>
              </div>
            ))
          )}
        </div>
      </div>
    </DrawerShell>
  );
}
