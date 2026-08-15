import { useQuery } from '@tanstack/react-query';
import { Button, makeStyles, tokens } from '@fluentui/react-components';

import { endpoints } from '../api/endpoints';
import type { FailureBundle, TestResult } from '../api/types';
import { ResultStatusBadge } from '../components/StatusBadge';
import { Mono } from '../components/MonoBlock';
import { DurationText } from '../components/DurationText';
import { ArtifactRow } from '../components/ArtifactRow';
import { DrawerShell, SectionLabel } from './DrawerShell';

const useStyles = makeStyles({
  idText: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  name: {
    fontSize: '16px',
    fontWeight: 600,
  },
  metaRow: {
    display: 'flex',
    gap: '14px',
    marginTop: '8px',
    color: tokens.colorNeutralForeground3,
    fontSize: '12px',
    flexWrap: 'wrap',
  },
  metaValue: {
    color: tokens.colorNeutralForeground1,
  },
  screenshotFailed: {
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
  visualTimeline: {
    display: 'flex',
    gap: '8px',
    overflowX: 'auto',
    paddingBottom: '4px',
    marginTop: '10px',
  },
  visualFrame: {
    minWidth: '150px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: '#191919',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
  },
  visualWarning: {
    marginTop: '8px',
    padding: '8px 10px',
    borderRadius: tokens.borderRadiusMedium,
    border: '1px solid #7a5c00',
    color: '#e6c86e',
    fontSize: '11px',
  },
  screenshotNone: {
    padding: '14px 16px',
    borderRadius: tokens.borderRadiusMedium,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    backgroundColor: '#191919',
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    lineHeight: 1.6,
  },
  entryList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  consoleEntry: {
    backgroundColor: '#161616',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '10px 12px',
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: '12px',
  },
  consoleHead: {
    display: 'flex',
    gap: '8px',
    alignItems: 'baseline',
  },
  consoleLevel: {
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  consoleSource: {
    marginTop: '4px',
    color: tokens.colorNeutralForeground3,
    fontSize: '11px',
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
  emptyNote: {
    padding: '12px 14px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: '#191919',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontSize: '12px',
    color: tokens.colorNeutralForeground4,
  },
  artifactList: {
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  fullHarLink: {
    marginTop: '8px',
    fontSize: '12px',
  },
});

const CONSOLE_LEVEL_COLOR: Record<string, string> = {
  error: '#dc626d',
  warning: '#eaa300',
};

export function ResultDrawer({
  result,
  open,
  matchingBundle,
  onClose,
  onOpenBundle,
}: {
  result: TestResult | null;
  open: boolean;
  matchingBundle: FailureBundle | null;
  onClose: () => void;
  onOpenBundle: (bundleId: string) => void;
}) {
  const styles = useStyles();
  const resultId = result?.id ?? null;

  const consoleQuery = useQuery({
    queryKey: ['resultConsole', resultId],
    queryFn: () => endpoints.resultConsole(resultId as string, { level: 'all', limit: 20 }),
    enabled: Boolean(resultId) && open,
  });
  const harQuery = useQuery({
    queryKey: ['resultHar', resultId],
    queryFn: () => endpoints.resultHarFailures(resultId as string),
    enabled: Boolean(resultId) && open,
  });
  const artifactsQuery = useQuery({
    queryKey: ['resultArtifacts', resultId],
    queryFn: () => endpoints.resultArtifacts(resultId as string),
    enabled: Boolean(resultId) && open,
  });
  const visualQuery = useQuery({
    queryKey: ['resultVisualEvidence', resultId],
    queryFn: () => endpoints.resultVisualEvidence(resultId as string),
    enabled: Boolean(resultId) && open,
  });

  if (!result) {
    return <DrawerShell open={open} onClose={onClose} titleContent={null} children={null} />;
  }

  const legacyScreenshot = artifactsQuery.data?.find((a) => a.type === 'screenshot');
  const visual = visualQuery.data?.status === 'captured' ? visualQuery.data : null;
  const screenshotUrl = visual?.finalScreenshot?.artifact?.url ?? legacyScreenshot?.url;
  const contactSheetUrl = visual?.contactSheet?.artifact?.url;

  async function openFullHar() {
    if (!resultId) return;
    const full = await endpoints.resultHarFull(resultId);
    window.open(full.url, '_blank', 'noopener,noreferrer');
  }

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      titleContent={
        <>
          <ResultStatusBadge status={result.status} flaky={result.flaky} />
          <span className={styles.idText}>
            <Mono>{result.id}</Mono>
          </span>
          <div style={{ flex: 1 }} />
          {matchingBundle ? (
            <Button appearance="primary" onClick={() => onOpenBundle(matchingBundle.bundle_id)}>
              Failure bundle &rarr;
            </Button>
          ) : null}
        </>
      }
    >
      <div>
        <div className={styles.name}>{result.test_name}</div>
        <div className={styles.metaRow}>
          <span>
            route: <span className={styles.metaValue}><Mono>{result.route_path}</Mono></span>
          </span>
          <span>
            role: <span className={styles.metaValue}>{result.role}</span>
          </span>
          <span>
            {result.browser} &middot; <Mono>{result.viewport}</Mono>
          </span>
          <span>
            duration:{' '}
            <span className={styles.metaValue}>
              <DurationText ms={result.duration_ms} />
            </span>
          </span>
          {result.reruns_attempted > 0 ? (
            <span>
              reruns: {result.reruns_attempted} attempted &middot; {result.reruns_failed} failed
            </span>
          ) : null}
        </div>
      </div>

      <div>
        <SectionLabel>Visual evidence</SectionLabel>
        {contactSheetUrl ? (
          <>
            <div className={styles.screenshotFailed}>
              <img className={styles.screenshotImg} src={contactSheetUrl} alt="Loading-sequence contact sheet" />
            </div>
            <div className={styles.visualTimeline} aria-label="Capture timeline">
              {visual?.frames.map((frame) => (
                <a
                  key={`${frame.index}-${frame.sha256}`}
                  className={styles.visualFrame}
                  href={frame.artifact?.url}
                  target={frame.artifact ? '_blank' : undefined}
                  rel={frame.artifact ? 'noreferrer' : undefined}
                  style={{ textDecoration: 'none', pointerEvents: frame.artifact ? 'auto' : 'none' }}
                >
                  <div><Mono>#{frame.index}</Mono> {frame.milestone}</div>
                  <div>{new Date(frame.capturedAt).toLocaleTimeString()}</div>
                  <div><Mono>{frame.width}&times;{frame.height}</Mono></div>
                </a>
              ))}
            </div>
          </>
        ) : null}
        {screenshotUrl ? (
          <>
            <div className={styles.idText} style={{ margin: '10px 0 6px' }}>Final asserted state</div>
            <div className={styles.screenshotFailed}>
              <img className={styles.screenshotImg} src={screenshotUrl} alt="Masked final screenshot" />
            </div>
          </>
        ) : (
          <div className={styles.screenshotNone}>
            {visualQuery.isLoading
              ? 'Loading visual evidence…'
              : 'No visual evidence was captured for this result.'}
          </div>
        )}
        {visual?.warnings.map((warning, index) => (
          <div key={index} className={styles.visualWarning}>{warning}</div>
        ))}
      </div>

      <div>
        <SectionLabel>
          Console <span style={{ fontWeight: 400 }}>&mdash; error + warning only, deduped, top 20</span>
        </SectionLabel>
        {!consoleQuery.data || consoleQuery.data.length === 0 ? (
          <div className={styles.emptyNote}>
            No console errors or warnings captured. Full stream in <Mono>console.jsonl</Mono>.
          </div>
        ) : (
          <div className={styles.entryList}>
            {consoleQuery.data.map((c, i) => (
              <div
                key={i}
                className={styles.consoleEntry}
                style={{ borderLeft: `3px solid ${CONSOLE_LEVEL_COLOR[c.level] ?? '#9e9e9e'}` }}
              >
                <div className={styles.consoleHead}>
                  <span
                    className={styles.consoleLevel}
                    style={{ color: CONSOLE_LEVEL_COLOR[c.level] ?? '#9e9e9e' }}
                  >
                    {c.level}
                  </span>
                  <span style={{ whiteSpace: 'pre-wrap', flex: 1 }}>{c.text}</span>
                </div>
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
          Network (HAR, filtered){' '}
          <span style={{ fontWeight: 400 }}>
            &mdash; &ge;400 / failed / &gt;3000 ms, bodies &le;512 B
          </span>
        </SectionLabel>
        {!harQuery.data || harQuery.data.length === 0 ? (
          <div className={styles.emptyNote}>
            No failing or slow requests. Full capture in <Mono>network.har</Mono>.
          </div>
        ) : (
          <div className={styles.entryList}>
            {harQuery.data.map((n, i) => (
              <div key={i} className={styles.consoleEntry}>
                <div className={styles.networkHead}>
                  <span style={{ fontWeight: 700 }}>{n.method}</span>
                  <span style={{ wordBreak: 'break-all' }}>{n.url_path}</span>
                  <span style={{ color: n.status >= 400 ? '#dc626d' : undefined, fontWeight: 700 }}>
                    {n.status}
                  </span>
                  <span style={{ color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap' }}>
                    {n.timing_ms} ms
                  </span>
                </div>
                <div className={styles.networkSnippet}>{n.resp_snippet}</div>
              </div>
            ))}
          </div>
        )}
        <div className={styles.fullHarLink}>
          <a href="#" onClick={(e) => { e.preventDefault(); void openFullHar(); }}>
            Full HAR (failures_only=false) &#8599;
          </a>{' '}
          <span className={styles.idText}>&mdash; signed URL, 7-day TTL</span>
        </div>
      </div>

      <div>
        <SectionLabel>Artifacts</SectionLabel>
        <div className={styles.artifactList}>
          {!artifactsQuery.data || artifactsQuery.data.length === 0 ? (
            <div className={styles.emptyNote}>No artifacts captured for this result.</div>
          ) : (
            artifactsQuery.data.map((a) => <ArtifactRow key={a.type} artifact={a} />)
          )}
        </div>
      </div>
    </DrawerShell>
  );
}
