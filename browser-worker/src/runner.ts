/**
 * @fileoverview Run orchestrator for the Auto QA browser worker. Invoked by the
 * control plane as `npx tsx src/runner.ts`; delegates policy and payload decisions
 * to unit-tested helpers and keeps subprocess/HTTP/filesystem glue explicit.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type RunnerConfig } from './lib/config';
import { buildMatrixArgs, buildFlakeRerunArgs } from './lib/playwrightArgs';
import { hasAnyFailures, isFailureStatus, isFlaky, setupFailed } from './lib/flake';
import {
  collectAttachments,
  attachmentKey,
  bindVisualManifestAttachmentNames,
  mapAttachmentType,
  type RawAttachment,
} from './lib/attachments';
import { resultKey } from './lib/slug';
import {
  buildFailedAction,
  buildResultIngest,
  isIngestableProject,
  pickFirstErrorEntry,
  resolveSignatureError,
  resolveTopFrame,
  postStarted,
  postResults,
  postResultsBatched,
  postFinalize,
  postProgress,
  type ArtifactEntry,
  type ResultIngest,
  type BatchIngestResult,
} from './lib/ingest';
import { findAuthExpiredFile } from './lib/authExpired';
import { isApplicableResult, parseReport, resolveRoutePath, type ParsedResult } from './reportParser';
import { analyzeHar } from './postprocess/harFilter';
import { filterConsole, type ConsoleEntry } from './postprocess/consoleFilter';
import { resolveFrame, type Fetcher } from './postprocess/sourcemap';
import { signatureInput } from './postprocess/normalize';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(SRC_DIR, '..');

const MATRIX_TIMEOUT_MS = 15 * 60 * 1000;
const FLAKE_RERUN_TIMEOUT_MS = 120_000;

type FlakeVerdict = { reruns_attempted: number; reruns_failed: number; flaky: boolean };

// consoleFilter.ts types `source` as strictly `null` (unresolved by construction). We
// resolve the first error's source in-place before emitting, so we widen locally rather
// than touch that file.
type ResolvableConsoleEntry = Omit<ConsoleEntry, 'source'> & { source: string | null };

function log(line: string): void {
  console.log(`[runner] ${line}`);
}

const fetcher: Fetcher = async (url) => {
  try {
    const res = await fetch(url);
    return { ok: res.ok, text: await res.text() };
  } catch {
    return { ok: false, text: '' };
  }
};

function childEnv(
  cfg: RunnerConfig,
  outputDir: string,
  reportPath: string,
  progress: 'on' | 'off' = 'on',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QA_PW_OUTPUT_DIR: outputDir,
    QA_PW_REPORT: reportPath,
    QA_RUN_ROLES: JSON.stringify(cfg.roles),
    QA_PW_BROWSER: cfg.browser,
    QA_PW_VIEWPORT: cfg.viewportLabel,
  };
  if (cfg.baseUrl) env.QA_RUN_BASE_URL = cfg.baseUrl;
  if (cfg.routes) env.QA_RUN_ROUTES = JSON.stringify(cfg.routes);
  // per-test progress is posted by the main matrix run only; flake reruns turn it off
  // so their single-test suites don't reset the main counter
  if (progress === 'on') env.QA_PROGRESS_PHASE = 'running';
  else env.QA_PROGRESS_OFF = '1';
  return env;
}

function runMatrix(
  cfg: RunnerConfig,
  outputDir: string,
  reportPath: string,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const args = buildMatrixArgs(cfg.roles);
    const child = spawn('npx', ['playwright', ...args], {
      cwd: WORKER_ROOT,
      env: childEnv(cfg, outputDir, reportPath),
      stdio: 'inherit',
      detached: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // process already gone
        }
      }
    }, MATRIX_TIMEOUT_MS);
    timer.unref();

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

// Isolated single-test rerun (doc 06 §5). We only need pass/fail, not the report, so a
// throwaway report path and the process exit code are enough.
function runFlakeRerun(cfg: RunnerConfig, role: string, testTitle: string, outputDir: string): boolean {
  const args = buildFlakeRerunArgs(role, testTitle);
  // Playwright WIPES outputDir on every invocation — reruns must never share the
  // matrix run's dir or they delete its attachments before the copy phase
  const flakeDir = `${outputDir}-flake`;
  const result = spawnSync('npx', ['playwright', ...args], {
    cwd: WORKER_ROOT,
    env: childEnv(cfg, flakeDir, path.join(flakeDir, 'flake-report.json'), 'off'),
    stdio: 'inherit',
    timeout: FLAKE_RERUN_TIMEOUT_MS,
  });
  return (result.status ?? 1) !== 0;
}

async function processResult(
  cfg: RunnerConfig,
  r: ParsedResult,
  attachmentsMap: Map<string, RawAttachment[]>,
  flakeInfo: Map<string, FlakeVerdict>,
  destRoot: string,
): Promise<ResultIngest> {
  const key = resultKey(r.role, r.test_name);
  const destDir = path.join(destRoot, 'runs', cfg.runId, key);
  fs.mkdirSync(destDir, { recursive: true });

  const rawAttachments = attachmentsMap.get(attachmentKey(r.role, r.test_name)) ?? [];
  const artifacts: ArtifactEntry[] = [];
  const artifactPaths = new Map<string, string>();

  bindVisualManifestAttachmentNames(rawAttachments);

  for (const att of rawAttachments) {
    const type = mapAttachmentType(att.name);
    if (!type || !att.path || !fs.existsSync(att.path)) continue;
    if (type === 'screenshot_frame' && !cfg.capturePolicy.retainIntermediateFrames) continue;
    const destPath = path.join(destDir, path.basename(att.path));
    fs.copyFileSync(att.path, destPath);
    const bytes = fs.statSync(destPath).size;
    artifacts.push({ type, storage_key: path.relative(destRoot, destPath), bytes });
    artifactPaths.set(type, destPath);
  }

  let manifestRoute: unknown = null;
  if (!r.route_path) {
    const manifestPath = artifactPaths.get('visual_manifest');
    if (manifestPath) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifestRoute = manifest.route;
      } catch {
        // Invalid manifests are rejected by control-plane ingestion; route recovery is best effort.
      }
    }
  }
  const resolvedRoutePath = resolveRoutePath(r.route_path, manifestRoute);

  const flake = flakeInfo.get(attachmentKey(r.role, r.test_name)) ?? {
    reruns_attempted: 0,
    reruns_failed: 0,
    flaky: false,
  };

  const failed = isFailureStatus(r.status);
  const failed_action = failed ? buildFailedAction(r.error_message) : null;

  let console_summary: ConsoleEntry[] = [];
  let network_summary: ReturnType<typeof analyzeHar> = [];
  let signature_input: Record<string, unknown> | null = null;

  const harPath = artifactPaths.get('har');
  if (harPath) {
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    network_summary = analyzeHar(har, cfg.harConfig);
  }

  const consolePath = artifactPaths.get('console');
  if (consolePath) {
    const lines = fs
      .readFileSync(consolePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    console_summary = filterConsole(lines, cfg.consoleConfig);
  }

  if (failed && !flake.flaky) {
    const mutableEntries = console_summary as unknown as ResolvableConsoleEntry[];
    const firstError = pickFirstErrorEntry(mutableEntries);
    let resolved: string | null = null;
    if (firstError?.raw_source) {
      resolved = await resolveFrame(firstError.raw_source, fetcher);
      firstError.source = resolved;
    }

    // signatureInput() returns a concrete shape (normalize.ts, not modified here); the
    // ResultIngest field is typed as a generic record to match the control-plane's
    // untyped JSON `dict` field.
    signature_input = signatureInput({
      error: resolveSignatureError(r.error_message, firstError?.text),
      topFrame: resolveTopFrame(resolved, firstError?.raw_source),
      route: resolvedRoutePath ?? '',
      role: r.role,
    }) as unknown as Record<string, unknown>;
  }

  return buildResultIngest({
    test_name: r.test_name,
    test_file: r.test_file,
    route_path: resolvedRoutePath,
    role: r.role,
    status: r.status,
    duration_ms: r.duration_ms,
    flaky: flake.flaky,
    reruns_attempted: flake.reruns_attempted,
    reruns_failed: flake.reruns_failed,
    failed_action,
    shell_rendered: null,
    console_summary,
    network_summary,
    dom_excerpt: null,
    signature_input,
    artifacts,
  }, { browser: cfg.browser, viewport: cfg.viewportLabel });
}

async function finalizeAndExit(
  cfg: RunnerConfig,
  status: 'completed' | 'failed' | 'auth_expired',
  detail?: string,
): Promise<never> {
  try {
    const res = await postFinalize(cfg, status, detail);
    log(`finalized: ${JSON.stringify(res)}`);
  } catch (err) {
    console.error(`[runner] control plane unreachable (finalize): ${(err as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  let cfg: RunnerConfig;
  try {
    cfg = loadConfig(process.env, WORKER_ROOT);
  } catch (err) {
    console.error(`[runner] config error: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  log(`run ${cfg.runId} starting (roles=${cfg.roles.join(',')})`);

  try {
    await postStarted(cfg);
  } catch (err) {
    console.error(`[runner] control plane unreachable (started): ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  // From here the run is marked "running" on the control plane: any uncaught error
  // must finalize the run as failed or it stays "running" forever with no signal.
  try {
    await runToCompletion(cfg);
  } catch (err) {
    const detail = `runner crashed: ${(err as Error)?.stack ?? String(err)}`;
    console.error(`[runner] ${detail}`);
    await finalizeAndExit(cfg, 'failed', detail.slice(0, 2000));
  }
}

async function runToCompletion(cfg: RunnerConfig): Promise<void> {
  const outputDir = path.join(WORKER_ROOT, 'test-results', cfg.runId);
  const reportPath = path.join(outputDir, 'report.json');
  fs.mkdirSync(outputDir, { recursive: true });

  await postProgress(cfg, { phase: 'starting', done: 0, total: 0, current: 'minting sessions' });
  log('running playwright matrix');
  const { code, timedOut } = await runMatrix(cfg, outputDir, reportPath);
  log(`playwright matrix exited (code=${code}, timedOut=${timedOut})`);

  if (!fs.existsSync(reportPath)) {
    const detail = timedOut
      ? 'Playwright matrix run timed out after 15 minutes with no report produced'
      : `Playwright matrix run crashed (exit code ${code}) and produced no report`;
    log(`no report produced: ${detail}`);
    await finalizeAndExit(cfg, 'failed', detail);
    return;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const allResults: ParsedResult[] = parseReport(report).filter(isApplicableResult);
  const attachmentsMap = collectAttachments(report);

  // auth setup failing (e.g. a project's QA_CRED_* not populated) skips every dependent
  // test — report that as a failed run rather than a false-green "completed"
  if (setupFailed(allResults)) {
    log('auth setup failed — finalizing run as failed');
    await finalizeAndExit(cfg, 'failed',
      'authentication setup failed (missing or invalid credentials for this project?)');
    return;
  }

  const results = allResults.filter((r) => isIngestableProject(r.role));

  log(`parsed ${results.length} matrix result(s)`);

  const flakeInfo = new Map<string, FlakeVerdict>();

  if (hasAnyFailures(results)) {
    const failing = results.filter((r) => isFailureStatus(r.status));
    log(`flake protocol: rerunning ${failing.length} failing result(s), N=${cfg.flakeReruns}`);
    let flakeDone = 0;
    await postProgress(cfg, { phase: 'flake-reruns', done: 0, total: failing.length, current: null });
    for (const r of failing) {
      await postProgress(cfg, { done: flakeDone, total: failing.length, current: r.test_name });
      let rerunsFailed = 0;
      for (let i = 0; i < cfg.flakeReruns; i++) {
        if (runFlakeRerun(cfg, r.role, r.test_name, outputDir)) rerunsFailed++;
      }
      flakeDone += 1;
      const flaky = isFlaky(rerunsFailed, cfg.flakeReruns);
      flakeInfo.set(attachmentKey(r.role, r.test_name), {
        reruns_attempted: cfg.flakeReruns,
        reruns_failed: rerunsFailed,
        flaky,
      });
      log(`flake: ${r.role}/${r.test_name} -> reruns_failed=${rerunsFailed}/${cfg.flakeReruns} flaky=${flaky}`);
    }
  }

  await postProgress(cfg, { phase: 'post-processing', done: 0, total: results.length, current: null });
  const ingestList: ResultIngest[] = [];
  for (const r of results) {
    ingestList.push(await processResult(cfg, r, attachmentsMap, flakeInfo, cfg.artifactsDir));
    await postProgress(cfg, { done: ingestList.length, total: results.length, current: r.test_name });
  }
  await postProgress(cfg, { phase: 'finalizing', current: null });

  const authExpiredPath = findAuthExpiredFile(outputDir);

  log(`posting ${ingestList.length} result(s) in batches`);
  const batchResult: BatchIngestResult = await postResultsBatched(cfg, ingestList, 20);

  if (batchResult.error) {
    const detail = `result ingestion partially failed after ${batchResult.ingested}/${ingestList.length} results: ${batchResult.error}`.slice(0, 2000);
    console.error(`[runner] ${detail}`);
    // If some results were ingested, finalize as completed-with-warnings rather than
    // marking the whole run failed — the control plane already persisted partial data.
    if (batchResult.ingested > 0) {
      log(`${batchResult.ingested} results ingested before quota hit — finalizing as completed`);
      await finalizeAndExit(cfg, 'completed', detail);
    } else {
      await finalizeAndExit(cfg, 'failed', detail);
    }
    return;
  }

  if (authExpiredPath) {
    const detail = fs.readFileSync(authExpiredPath, 'utf8');
    log(`AUTH_EXPIRED sentinel found: ${detail}`);
    await finalizeAndExit(cfg, 'auth_expired', detail);
    return;
  }

  await finalizeAndExit(cfg, 'completed');
}

main().catch((err) => {
  console.error(`[runner] fatal: ${(err as Error)?.stack ?? err}`);
  process.exit(1);
});
