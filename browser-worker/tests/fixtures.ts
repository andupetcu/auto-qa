import fs from 'node:fs';
import path from 'node:path';

import { test as base, expect, type BrowserContext } from '@playwright/test';

import { resultKey } from '../src/lib/slug';
import { VisualCaptureSession } from '../src/visual/capture';
import { parseCapturePolicy } from '../src/visual/policy';
import { resolveRoles, sessionStatePath } from './projectConfig';

interface ConsoleEntry {
  level: string;
  text: string;
  url: string;
  line: number;
  column: number;
  timestamp: string;
}

const capturePolicy = parseCapturePolicy(process.env.QA_RUN_CAPTURE_POLICY);

function configuredViewport(): { width: number; height: number } | undefined {
  const match = (process.env.QA_PW_VIEWPORT ?? '').match(/^(\d+)x(\d+)$/);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

export const test = base.extend<{ context: BrowserContext }>({
  context: async ({ browser }, use, testInfo) => {
    const projectName = testInfo.project.name;
    const role = resolveRoles(process.env).find((candidate) => candidate.name === projectName);
    const harPath = testInfo.outputPath('network.har');
    const consolePath = testInfo.outputPath('console.jsonl');
    const context = await browser.newContext({
      baseURL: process.env.QA_RUN_BASE_URL ?? process.env.QA_BASE_URL_DEFAULT,
      viewport: configuredViewport(),
      storageState: role?.credential_ref
        ? sessionStatePath(process.env, projectName)
        : undefined,
      ...(capturePolicy.har === 'reduced'
        ? { recordHar: { path: harPath, content: 'embed', mode: 'full' } as const }
        : {}),
      ...(capturePolicy.video !== 'off'
        ? { recordVideo: { dir: testInfo.outputPath('video'), size: configuredViewport() } }
        : {}),
    });

    const entries: ConsoleEntry[] = [];
    context.on('page', (page) => {
      page.on('console', (message) => {
        const location = message.location();
        entries.push({
          level: message.type(),
          text: message.text(),
          url: location.url ?? '',
          line: location.lineNumber ?? 0,
          column: location.columnNumber ?? 0,
          timestamp: new Date().toISOString(),
        });
      });
      page.on('pageerror', (error) => {
        entries.push({
          level: 'error',
          text: error.message,
          url: page.url(),
          line: 0,
          column: 0,
          timestamp: new Date().toISOString(),
        });
      });
    });

    await use(context);
    await context.close();

    fs.mkdirSync(path.dirname(consolePath), { recursive: true });
    fs.writeFileSync(
      consolePath,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''),
    );
    await testInfo.attach('console', { path: consolePath, contentType: 'application/x-ndjson' });
    if (capturePolicy.har === 'reduced' && fs.existsSync(harPath)) {
      await testInfo.attach('har', { path: harPath, contentType: 'application/json' });
    }
  },

  page: async ({ context }, use, testInfo) => {
    const page = await context.newPage();
    const titleRoute = testInfo.title.match(/^matrix (\S+) as /)?.[1] ?? '';
    const visual = new VisualCaptureSession(
      page,
      capturePolicy,
      testInfo.outputPath('visual'),
      {
        resultKey: resultKey(testInfo.project.name, testInfo.title),
        route: titleRoute,
        role: testInfo.project.name,
        browser: process.env.QA_PW_BROWSER ?? 'chromium',
        viewport: process.env.QA_PW_VIEWPORT ?? '1440x900',
        contactSheetMaxPixels: Number(process.env.QA_CAPTURE_SHEET_MAX_PIXELS ?? 16_777_216),
        contactSheetMaxBytes: Number(process.env.QA_CAPTURE_SHEET_MAX_BYTES ?? 4_194_304),
      },
    );
    const timers = new Set<NodeJS.Timeout>();

    if (capturePolicy.loadingSequence.milestones.includes('navigation')) {
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) void visual.captureFrame('navigation');
      });
    }
    if (capturePolicy.loadingSequence.milestones.includes('domcontentloaded')) {
      page.on('domcontentloaded', () => {
        void visual.captureFrame('domcontentloaded');
        for (const delay of capturePolicy.loadingSequence.delaysMs) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            void visual.captureFrame('delay');
          }, delay);
          timers.add(timer);
        }
      });
    }

    const video = page.video();
    await use(page);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();

    const output = await visual.finish();
    if (output.finalScreenshot) {
      await testInfo.attach('screenshot', {
        path: output.finalScreenshot.path,
        contentType: capturePolicy.finalScreenshot.format === 'jpeg' ? 'image/jpeg' : 'image/png',
      });
    }
    if (output.contactSheet) {
      await testInfo.attach('contact_sheet', {
        path: path.join(testInfo.outputPath('visual'), output.contactSheet.filename),
        contentType: 'image/webp',
      });
    }
    if (capturePolicy.retainIntermediateFrames) {
      for (const frame of output.frames) {
        await testInfo.attach('screenshot_frame', { path: frame.path, contentType: 'image/png' });
      }
    }
    await testInfo.attach('visual_manifest', {
      path: output.manifestPath,
      contentType: 'application/json',
    });

    await page.close();
    const retainVideo = capturePolicy.video === 'on' || (
      capturePolicy.video === 'retain-on-failure' && testInfo.status !== testInfo.expectedStatus
    );
    if (video && retainVideo) {
      try {
        const videoPath = await video.path();
        if (fs.existsSync(videoPath)) {
          await testInfo.attach('video', { path: videoPath, contentType: 'video/webm' });
        }
      } catch {
        // Video evidence is optional and must never change the test verdict.
      }
    }
  },
});

export { expect };
