/** @fileoverview Bounded, masked lifecycle capture and settled/failure evidence output. */
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { normalizeRoutePath } from '../lib/routePath';

import {
  buildVisualManifest,
  createContactSheet,
  describeFrameFile,
  type FrameMilestone,
  type VisualFileDescriptor,
  type VisualFrameDescriptor,
} from './artifacts';
import type { CapturePolicy } from './policy';
import type { FrameState, ReadinessSummary } from './readiness';

export interface VisualCaptureMetadata {
  resultKey: string;
  route: string;
  role: string;
  browser: string;
  viewport: string;
  contactSheetMaxPixels: number;
  contactSheetMaxBytes: number;
}

export interface VisualCaptureOutput {
  frames: VisualFrameDescriptor[];
  finalScreenshot: VisualFrameDescriptor | null;
  contactSheet: VisualFileDescriptor | null;
  manifestPath: string;
  warnings: string[];
}

function warningMessage(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`.slice(0, 500);
}

export class VisualCaptureSession {
  private readonly frames: VisualFrameDescriptor[] = [];
  private readonly warnings: string[] = [];
  private queue: Promise<void> = Promise.resolve();
  private candidate = 0;
  private finished = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly page: Page,
    private readonly policy: CapturePolicy,
    private readonly outputDir: string,
    private readonly metadata: VisualCaptureMetadata,
  ) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  setRoute(route: string): void {
    const normalized = normalizeRoutePath(route);
    if (normalized) this.metadata.route = normalized;
  }

  private defaultState(): FrameState {
    return {
      elapsedMs: Math.max(0, Date.now() - this.startedAt),
      readinessState: 'observing',
      pendingCriticalRequests: 0,
      visibleLoadingSelectors: [],
    };
  }

  private async masks() {
    const valid = [];
    for (const selector of this.policy.maskSelectors) {
      try {
        const locator = this.page.locator(selector);
        await locator.count();
        valid.push(locator);
      } catch (error) {
        this.warnings.push(warningMessage(`mask selector ${selector} ignored`, error));
      }
    }
    return valid;
  }

  private async screenshot(
    filePath: string,
    options: {
      type: 'png' | 'jpeg';
      fullPage: boolean;
      animations: 'allow' | 'disabled';
      quality?: number;
    },
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.page.screenshot({
          path: filePath,
          type: options.type,
          fullPage: options.fullPage,
          animations: options.animations,
          caret: 'hide',
          mask: await this.masks(),
          maskColor: '#000000',
          ...(options.quality === undefined ? {} : { quality: options.quality }),
        });
        return;
      } catch (error) {
        lastError = error;
        const transient = /Unable to capture screenshot|Protocol error|Timeout/i.test(
          error instanceof Error ? error.message : String(error),
        );
        if (!transient || attempt > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  }

  captureFrame(
    milestone: FrameMilestone,
    capturedAt: string = new Date().toISOString(),
    state: FrameState = this.defaultState(),
  ): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.finished || !this.policy.loadingSequence.enabled) return;
      const terminalMilestone = milestone === 'settled' || milestone === 'timeout';
      if (this.frames.length >= this.policy.loadingSequence.maxFrames) {
        if (!terminalMilestone) return;
        const replaced = this.frames.pop();
        if (replaced) fs.rmSync(replaced.path, { force: true });
      }
      const nextIndex = this.frames.length;
      const candidate = this.candidate++;
      const candidatePath = path.join(
        this.outputDir,
        `.candidate-${candidate.toString().padStart(2, '0')}.png`,
      );
      try {
        await this.screenshot(candidatePath, {
          type: 'png',
          fullPage: false,
          animations: 'allow',
        });
        const descriptor = await describeFrameFile(
          candidatePath,
          this.frames.length,
          milestone,
          capturedAt,
          state,
        );
        const duplicate = this.frames.find((frame) => frame.sha256 === descriptor.sha256);
        if (duplicate) {
          if (terminalMilestone) {
            duplicate.milestone = milestone;
            duplicate.capturedAt = capturedAt;
            duplicate.elapsedMs = state.elapsedMs;
            duplicate.readinessState = state.readinessState;
            duplicate.pendingCriticalRequests = state.pendingCriticalRequests;
            duplicate.visibleLoadingSelectors = [...state.visibleLoadingSelectors];
          }
          fs.rmSync(candidatePath, { force: true });
          return;
        }
        const finalPath = path.join(
          this.outputDir,
          `frame-${descriptor.index.toString().padStart(2, '0')}-${milestone}.png`,
        );
        fs.renameSync(candidatePath, finalPath);
        descriptor.path = finalPath;
        descriptor.filename = path.basename(finalPath);
        this.frames.push(descriptor);
      } catch (error) {
        fs.rmSync(candidatePath, { force: true });
        this.warnings.push(warningMessage(`frame ${milestone} capture failed`, error));
      }
    });
    return this.queue;
  }

  private async captureFinal(
    capturedAt: string,
    readiness: ReadinessSummary | null,
  ): Promise<VisualFrameDescriptor | null> {
    if (!this.policy.finalScreenshot.enabled) return null;
    const extension = this.policy.finalScreenshot.format === 'jpeg' ? 'jpg' : 'png';
    const finalPath = path.join(this.outputDir, `final-screenshot.${extension}`);
    try {
      await this.screenshot(finalPath, {
        type: this.policy.finalScreenshot.format,
        fullPage: this.policy.finalScreenshot.fullPage,
        animations: 'disabled',
        ...(this.policy.finalScreenshot.format === 'jpeg' ? { quality: 85 } : {}),
      });
      return await describeFrameFile(
        finalPath,
        this.frames.length,
        readiness?.status === 'passed' ? 'settled' : 'asserted',
        capturedAt,
        {
          elapsedMs: readiness?.elapsedMs ?? Math.max(0, Date.now() - this.startedAt),
          readinessState: readiness?.status === 'passed' ? 'settled' : (
            readiness?.status === 'timed_out' ? 'timed_out' : 'observing'
          ),
          pendingCriticalRequests: readiness?.pendingCriticalRequests ?? 0,
          visibleLoadingSelectors: readiness?.visibleLoadingSelectors ?? [],
        },
      );
    } catch (error) {
      fs.rmSync(finalPath, { force: true });
      this.warnings.push(warningMessage('final screenshot capture failed', error));
      return null;
    }
  }

  async finish(
    capturedAt: string = new Date().toISOString(),
    readiness: ReadinessSummary | null = null,
  ): Promise<VisualCaptureOutput> {
    if (
      this.policy.loadingSequence.enabled &&
      this.policy.loadingSequence.milestones.includes('asserted') &&
      !this.frames.some((frame) => frame.milestone === 'asserted')
    ) {
      await this.captureFrame('asserted', capturedAt, readiness ? {
        elapsedMs: readiness.elapsedMs,
        readinessState: readiness.status === 'passed' ? 'settled' : (
          readiness.status === 'timed_out' ? 'timed_out' : 'observing'
        ),
        pendingCriticalRequests: readiness.pendingCriticalRequests,
        visibleLoadingSelectors: readiness.visibleLoadingSelectors,
      } : this.defaultState());
    }
    await this.queue;
    this.finished = true;

    const finalScreenshot = await this.captureFinal(capturedAt, readiness);
    let contactSheet: VisualFileDescriptor | null = null;
    const sheetFrames = this.frames.length > 0
      ? this.frames
      : (finalScreenshot ? [finalScreenshot] : []);
    if (this.policy.contactSheet.enabled && sheetFrames.length > 0) {
      try {
        contactSheet = await createContactSheet(
          sheetFrames,
          path.join(this.outputDir, 'contact-sheet.webp'),
          {
            quality: this.policy.contactSheet.quality,
            maxPixels: this.metadata.contactSheetMaxPixels,
            maxBytes: this.metadata.contactSheetMaxBytes,
            labels: {
              route: this.metadata.route,
              role: this.metadata.role,
              browser: this.metadata.browser,
              viewport: this.metadata.viewport,
            },
          },
        );
      } catch (error) {
        this.warnings.push(warningMessage('contact sheet generation failed', error));
      }
    }

    const manifest = buildVisualManifest({
      resultKey: this.metadata.resultKey,
      route: this.metadata.route,
      role: this.metadata.role,
      browser: this.metadata.browser,
      viewport: this.metadata.viewport,
      policyVersion: this.policy.version,
      frames: this.frames,
      finalScreenshot,
      contactSheet,
      readiness,
      warnings: this.warnings,
    });
    const manifestPath = path.join(this.outputDir, 'visual-manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      frames: [...this.frames],
      finalScreenshot,
      contactSheet,
      manifestPath,
      warnings: [...this.warnings],
    };
  }
}
