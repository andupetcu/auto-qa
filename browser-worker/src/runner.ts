// Run orchestrator for the Footprints QA browser worker (v0.1). Invoked by the control
// plane as `npx tsx src/runner.ts` (cwd = browser-worker). Deliberately thin: every
// decision (payload shape, flake verdict, artifact keys/types, CLI args) is delegated to
// the pure, unit-tested helpers under src/lib/*.ts and src/postprocess/*.ts — this file is
// just subprocess/HTTP/filesystem glue, exercised for real by the live E2E smoke.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, type RunnerConfig } from './lib/config';
import { buildMatrixArgs, buildFlakeRerunArgs } from './lib/playwrightArgs';
import { hasAnyFailures, isFailureStatus, isFlaky } from './lib/flake';
import { collectAttachments, attachmentKey, mapAttachmentType, type RawAttachment } from './lib/attachments';
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
  postFinalize,
  type ArtifactEntry,
  type ResultIngest,
} from './lib/ingest';
import { findAuthExpiredFile } from './lib/authExpired';
import { parseReport, type ParsedResult } from './reportParser';
import { filterHar } from './postprocess/harFilter';
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

function childEnv(cfg: RunnerConfig, outputDir: string, reportPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QA_PW_OUTPUT_DIR: outputDir,
    QA_PW_REPORT: reportPath,
    QA_RUN_ROLES: JSON.stringify(cfg.roles),
  };
  if (cfg.baseUrl) env.QA_RUN_BASE_URL = cfg.baseUrl;
  if (cfg.routes) env.QA_RUN_ROUTES = JSON.stringify(cfg.routes);
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
  const result = spawnSync('npx', ['playwright', ...args], {
    cwd: WORKER_ROOT,
    env: childEnv(cfg, outputDir, path.join(outputDir, 'flake-report.json')),
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

  for (const att of rawAttachments) {
    const type = mapAttachmentType(att.name);
    if (!type || !att.path || !fs.existsSync(att.path)) continue;
    const destPath = path.join(destDir, path.basename(att.path));
    fs.copyFileSync(att.path, destPath);
    const bytes = fs.statSync(destPath).size;
    artifacts.push({ type, storage_key: path.relative(destRoot, destPath), bytes });
    artifactPaths.set(type, destPath);
  }

  const flake = flakeInfo.get(attachmentKey(r.role, r.test_name)) ?? {
    reruns_attempted: 0,
    reruns_failed: 0,
    flaky: false,
  };

  const failed = isFailureStatus(r.status);
  const failed_action = failed ? buildFailedAction(r.error_message) : null;

  let console_summary: ConsoleEntry[] = [];
  let network_summary: ReturnType<typeof filterHar> = [];
  let signature_input: Record<string, unknown> | null = null;

  if (failed && !flake.flaky) {
    const harPath = artifactPaths.get('har');
    if (harPath) {
      const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
      network_summary = filterHar(har, cfg.harConfig);
    }

    const consolePath = artifactPaths.get('console');
    if (consolePath) {
      const lines = fs
        .readFileSync(consolePath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      console_summary = filterConsole(lines, cfg.consoleConfig);
    }

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
      route: r.route_path ?? '',
      role: r.role,
    }) as unknown as Record<string, unknown>;
  }

  return buildResultIngest({
    test_name: r.test_name,
    test_file: r.test_file,
    route_path: r.route_path,
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
  });
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

  const outputDir = path.join(WORKER_ROOT, 'test-results', cfg.runId);
  const reportPath = path.join(outputDir, 'report.json');
  fs.mkdirSync(outputDir, { recursive: true });

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
  const allResults: ParsedResult[] = parseReport(report);
  const attachmentsMap = collectAttachments(report);
  const results = allResults.filter((r) => isIngestableProject(r.role));

  log(`parsed ${results.length} matrix result(s)`);

  const flakeInfo = new Map<string, FlakeVerdict>();

  if (hasAnyFailures(results)) {
    const failing = results.filter((r) => isFailureStatus(r.status));
    log(`flake protocol: rerunning ${failing.length} failing result(s), N=${cfg.flakeReruns}`);
    for (const r of failing) {
      let rerunsFailed = 0;
      for (let i = 0; i < cfg.flakeReruns; i++) {
        if (runFlakeRerun(cfg, r.role, r.test_name, outputDir)) rerunsFailed++;
      }
      const flaky = isFlaky(rerunsFailed, cfg.flakeReruns);
      flakeInfo.set(attachmentKey(r.role, r.test_name), {
        reruns_attempted: cfg.flakeReruns,
        reruns_failed: rerunsFailed,
        flaky,
      });
      log(`flake: ${r.role}/${r.test_name} -> reruns_failed=${rerunsFailed}/${cfg.flakeReruns} flaky=${flaky}`);
    }
  }

  const ingestList: ResultIngest[] = [];
  for (const r of results) {
    ingestList.push(await processResult(cfg, r, attachmentsMap, flakeInfo, cfg.artifactsDir));
  }

  const authExpiredPath = findAuthExpiredFile(outputDir);

  log(`posting ${ingestList.length} result(s)`);
  try {
    await postResults(cfg, ingestList);
  } catch (err) {
    console.error(`[runner] control plane unreachable (results): ${(err as Error).message}`);
    process.exit(1);
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
