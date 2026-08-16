/**
 * @fileoverview Application-agnostic readiness monitor for critical network,
 * browser runtime, selector state, and bounded visual stability.
 */
import type { ConsoleMessage, Page, Request, Response } from '@playwright/test';
import sharp from 'sharp';

import type { ReadinessPolicy, RequestRule } from './policy';

export type ReadinessState = 'observing' | 'loading' | 'settled' | 'timed_out' | 'failed';
export type LifecycleMilestone =
  | 'navigation'
  | 'domcontentloaded'
  | 'delay'
  | 'loading'
  | 'critical-response'
  | 'asserted'
  | 'settled'
  | 'timeout';

export interface FrameState {
  elapsedMs: number;
  readinessState: ReadinessState;
  pendingCriticalRequests: number;
  visibleLoadingSelectors: string[];
}

export interface NetworkEventSummary {
  method: string;
  urlPath: string;
  resourceType: string;
  status: number;
  timingMs: number;
  failure: string | null;
}

export interface RuntimeEventSummary {
  kind: 'pageerror' | 'console';
  level: string;
  text: string;
  urlPath: string;
}

export interface ReadinessSummary {
  policyVersion: 1;
  status: 'passed' | 'failed' | 'timed_out' | 'disabled';
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  stabilityWindowMs: number;
  observedStableMs: number;
  pendingCriticalRequests: number;
  visibleLoadingSelectors: string[];
  missingReadySelectors: string[];
  criticalRequestsStarted: number;
  criticalRequestsCompleted: number;
  criticalRequestFailures: NetworkEventSummary[];
  runtimeErrors: RuntimeEventSummary[];
  reasons: string[];
}

export type LifecycleCapture = (milestone: LifecycleMilestone, state: FrameState) => Promise<void> | void;

function globRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`);
}

export function requestMatchesRule(
  input: { url: string; method: string; resourceType: string },
  rule: RequestRule,
): boolean {
  return globRegex(rule.urlGlob).test(input.url)
    && (rule.methods.length === 0 || rule.methods.includes(input.method))
    && (rule.resourceTypes.length === 0 || rule.resourceTypes.includes(input.resourceType as never));
}

export function isCriticalRequest(
  input: { url: string; method: string; resourceType: string },
  policy: ReadinessPolicy,
): boolean {
  if (policy.ignoredRequests.some((rule) => requestMatchesRule(input, rule))) return false;
  return policy.criticalRequests.some((rule) => requestMatchesRule(input, rule));
}

function safePath(raw: string): string {
  try {
    const url = new URL(raw);
    return url.pathname;
  } catch {
    return raw.split(/[?#]/, 1)[0].slice(0, 500);
  }
}

function boundedText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

interface PendingRequest {
  started: number;
  method: string;
  url: string;
  resourceType: string;
  status: number;
}

export class ReadinessMonitor {
  private readonly startedMonotonic = Date.now();
  private readonly startedAt = new Date().toISOString();
  private readonly pending = new Map<Request, PendingRequest>();
  private readonly failures: NetworkEventSummary[] = [];
  private readonly runtimeErrors: RuntimeEventSummary[] = [];
  private criticalStarted = 0;
  private criticalCompleted = 0;
  private lastCaptureAt = 0;
  private previousVisual: Buffer | null = null;
  private stableSince: number | null = null;
  private visualSamplingError: string | null = null;
  private stopped = false;

  constructor(
    private readonly page: Page,
    private readonly policy: ReadinessPolicy,
    private readonly capture: LifecycleCapture,
  ) {
    page.on('request', this.onRequest);
    page.on('response', this.onResponse);
    page.on('requestfinished', this.onRequestFinished);
    page.on('requestfailed', this.onRequestFailed);
    page.on('pageerror', this.onPageError);
    page.on('console', this.onConsole);
  }

  private input(request: Request) {
    return { url: request.url(), method: request.method(), resourceType: request.resourceType() };
  }

  private readonly onRequest = (request: Request): void => {
    const input = this.input(request);
    if (!isCriticalRequest(input, this.policy)) return;
    this.criticalStarted += 1;
    this.pending.set(request, { ...input, started: Date.now(), status: 0 });
  };

  private readonly onResponse = (response: Response): void => {
    const request = response.request();
    const tracked = this.pending.get(request);
    if (tracked) tracked.status = response.status();
  };

  private complete(request: Request, failure: string | null): void {
    const tracked = this.pending.get(request);
    if (!tracked) return;
    this.pending.delete(request);
    this.criticalCompleted += 1;
    const entry: NetworkEventSummary = {
      method: tracked.method,
      urlPath: safePath(tracked.url),
      resourceType: tracked.resourceType,
      status: tracked.status,
      timingMs: Math.max(0, Date.now() - tracked.started),
      failure: failure ? boundedText(failure) : null,
    };
    if (failure || tracked.status <= 0 || tracked.status >= 400) this.failures.push(entry);
    void this.capture('critical-response', this.frameState('observing', []));
  }

  private readonly onRequestFinished = (request: Request): void => this.complete(request, null);
  private readonly onRequestFailed = (request: Request): void => {
    this.complete(request, request.failure()?.errorText ?? 'request failed');
  };

  private readonly onPageError = (error: Error): void => {
    this.runtimeErrors.push({
      kind: 'pageerror', level: 'error', text: boundedText(error.message), urlPath: safePath(this.page.url()),
    });
  };

  private readonly onConsole = (message: ConsoleMessage): void => {
    if (message.type() !== 'error') return;
    this.runtimeErrors.push({
      kind: 'console', level: 'error', text: boundedText(message.text()), urlPath: safePath(message.location().url || this.page.url()),
    });
  };

  private frameState(state: ReadinessState, visible: string[]): FrameState {
    return {
      elapsedMs: Math.max(0, Date.now() - this.startedMonotonic),
      readinessState: state,
      pendingCriticalRequests: this.pending.size,
      visibleLoadingSelectors: [...visible],
    };
  }

  private async visibleSelectors(selectors: string[]): Promise<{ visible: string[]; invalid: string[] }> {
    const visible: string[] = [];
    const invalid: string[] = [];
    for (const selector of selectors) {
      try {
        const locator = this.page.locator(selector);
        if (await locator.first().isVisible()) visible.push(selector);
      } catch {
        invalid.push(selector);
      }
    }
    return { visible, invalid };
  }

  private async visualSample(): Promise<Buffer | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const screenshot = await this.page.screenshot({
          type: 'png', fullPage: false, animations: 'disabled', caret: 'hide',
        });
        this.visualSamplingError = null;
        return await sharp(screenshot)
          .resize(160, 90, { fit: 'fill' })
          .removeAlpha()
          .greyscale()
          .raw()
          .toBuffer();
      } catch (error) {
        this.visualSamplingError = error instanceof Error ? error.message : String(error);
        const transient = /Unable to capture screenshot|Protocol error|Timeout/i.test(
          this.visualSamplingError,
        );
        if (!transient || attempt > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return null;
  }

  private visualDiff(left: Buffer, right: Buffer): number {
    if (left.length !== right.length || left.length === 0) return 1;
    let changed = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (Math.abs(left[index] - right[index]) > 8) changed += 1;
    }
    return changed / left.length;
  }

  private fatalReasons(invalid: string[]): string[] {
    const reasons: string[] = [];
    if (this.policy.failOnCriticalRequest && this.failures.length > 0) {
      reasons.push(`${this.failures.length} critical request failure(s)`);
    }
    if (invalid.length > 0) reasons.push(`${invalid.length} readiness selector(s) invalid`);
    if (
      this.policy.failOnPageError
      && this.runtimeErrors.some((entry) => entry.kind === 'pageerror')
    ) reasons.push('page error captured');
    if (
      this.policy.failOnConsoleError
      && this.runtimeErrors.some((entry) => entry.kind === 'console')
    ) reasons.push('console error captured');
    return reasons;
  }

  private reasons(visible: string[], missing: string[], invalid: string[]): string[] {
    const reasons: string[] = [];
    if (this.pending.size > 0) reasons.push(`${this.pending.size} critical request(s) still pending`);
    if (this.policy.failOnCriticalRequest && this.failures.length > 0) reasons.push(`${this.failures.length} critical request failure(s)`);
    if (visible.length > 0) reasons.push(`${visible.length} loading selector(s) still visible`);
    if (missing.length > 0) reasons.push(`${missing.length} ready selector(s) missing`);
    if (invalid.length > 0) reasons.push(`${invalid.length} readiness selector(s) invalid`);
    if (this.policy.failOnPageError && this.runtimeErrors.some((entry) => entry.kind === 'pageerror')) reasons.push('page error captured');
    if (this.policy.failOnConsoleError && this.runtimeErrors.some((entry) => entry.kind === 'console')) reasons.push('console error captured');
    return reasons;
  }

  async assess(): Promise<ReadinessSummary> {
    if (!this.policy.enabled) return this.summary('disabled', 0, [], [], []);
    const deadline = this.startedMonotonic + this.policy.timeoutMs;
    let lastVisibleKey = '';
    let observedStableMs = 0;

    while (Date.now() <= deadline) {
      const loading = await this.visibleSelectors(this.policy.loadingSelectors);
      const ready = await this.visibleSelectors(this.policy.readySelectors);
      const missing = this.policy.readySelectors.filter((selector) => !ready.visible.includes(selector));
      const invalid = [...loading.invalid, ...ready.invalid];
      const visibleKey = loading.visible.join('\0');
      const now = Date.now();
      if (visibleKey !== lastVisibleKey || now - this.lastCaptureAt >= this.policy.captureIntervalMs) {
        lastVisibleKey = visibleKey;
        this.lastCaptureAt = now;
        await this.capture('loading', this.frameState('loading', loading.visible));
      }

      const fatalReasons = this.fatalReasons(invalid);
      if (fatalReasons.length > 0) {
        return this.summary('failed', observedStableMs, loading.visible, missing, invalid);
      }
      const reasons = this.reasons(loading.visible, missing, invalid);
      if (reasons.length === 0) {
        const sample = await this.visualSample();
        if (sample === null) {
          this.stableSince = null;
          observedStableMs = 0;
        } else if (
          this.previousVisual
          && this.visualDiff(this.previousVisual, sample) <= this.policy.visualDiffRatio
        ) {
          this.stableSince ??= now;
          observedStableMs = now - this.stableSince;
        } else {
          this.stableSince = now;
          observedStableMs = 0;
        }
        if (sample !== null) this.previousVisual = sample;
        if (sample !== null && observedStableMs >= this.policy.stabilityWindowMs) {
          await this.capture('settled', this.frameState('settled', []));
          return this.summary('passed', observedStableMs, [], [], invalid);
        }
      } else {
        this.stableSince = null;
        observedStableMs = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, this.policy.pollIntervalMs));
    }

    const loading = await this.visibleSelectors(this.policy.loadingSelectors);
    const ready = await this.visibleSelectors(this.policy.readySelectors);
    const missing = this.policy.readySelectors.filter((selector) => !ready.visible.includes(selector));
    const invalid = [...loading.invalid, ...ready.invalid];
    await this.capture('timeout', this.frameState('timed_out', loading.visible));
    return this.summary('timed_out', observedStableMs, loading.visible, missing, invalid);
  }

  private summary(
    status: ReadinessSummary['status'],
    observedStableMs: number,
    visible: string[],
    missing: string[],
    invalid: string[],
  ): ReadinessSummary {
    const reasons = this.reasons(visible, missing, invalid);
    if (this.visualSamplingError) {
      reasons.push('visual stability sampling unavailable');
    }
    return {
      policyVersion: 1,
      status,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - this.startedMonotonic),
      stabilityWindowMs: this.policy.stabilityWindowMs,
      observedStableMs,
      pendingCriticalRequests: this.pending.size,
      visibleLoadingSelectors: [...visible],
      missingReadySelectors: [...missing],
      criticalRequestsStarted: this.criticalStarted,
      criticalRequestsCompleted: this.criticalCompleted,
      criticalRequestFailures: this.failures.slice(0, 20),
      runtimeErrors: this.runtimeErrors.slice(0, 20),
      reasons,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.page.off('request', this.onRequest);
    this.page.off('response', this.onResponse);
    this.page.off('requestfinished', this.onRequestFinished);
    this.page.off('requestfailed', this.onRequestFailed);
    this.page.off('pageerror', this.onPageError);
    this.page.off('console', this.onConsole);
  }
}
