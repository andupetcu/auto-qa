/**
 * @fileoverview Real-browser and failure-isolation tests for masked visual capture.
 */
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

import { VisualCaptureSession } from '../src/visual/capture';
import { DEFAULT_CAPTURE_POLICY } from '../src/visual/policy';

describe('VisualCaptureSession', () => {
  test('masks every capture, deduplicates exact frames, and obeys maxFrames', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-capture-'));
    const red = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#c00000' },
    }).png().toBuffer();
    const blue = await sharp({
      create: { width: 120, height: 80, channels: 3, background: '#0000c0' },
    }).png().toBuffer();
    const outputs = [red, red, blue, blue];
    const screenshotCalls: Array<Record<string, unknown>> = [];
    const page = {
      locator: (selector: string) => ({ selector, count: async () => 1 }),
      screenshot: async (options: Record<string, unknown>) => {
        screenshotCalls.push(options);
        const content = outputs.shift() ?? blue;
        fs.writeFileSync(options.path as string, content);
        return content;
      },
    };
    const policy = structuredClone(DEFAULT_CAPTURE_POLICY);
    policy.loadingSequence.maxFrames = 2;
    policy.maskSelectors = ["input[type='password']", '[data-sensitive]'];

    const capture = new VisualCaptureSession(page as never, policy, dir, {
      resultKey: 'user-matrix-test',
      route: '/test',
      role: 'user',
      browser: 'chromium',
      viewport: '120x80',
      contactSheetMaxPixels: 1_000_000,
      contactSheetMaxBytes: 300_000,
    });
    await capture.captureFrame('navigation', '2026-08-15T08:00:00.000Z');
    await capture.captureFrame('domcontentloaded', '2026-08-15T08:00:00.100Z');
    await capture.captureFrame('delay', '2026-08-15T08:00:00.200Z');
    await capture.captureFrame('delay', '2026-08-15T08:00:00.300Z');
    const output = await capture.finish('2026-08-15T08:00:01.000Z');

    expect(output.frames).toHaveLength(2);
    expect(new Set(output.frames.map((frame) => frame.sha256)).size).toBe(2);
    expect(output.finalScreenshot).not.toBeNull();
    expect(output.contactSheet).not.toBeNull();
    expect(fs.existsSync(output.manifestPath)).toBe(true);
    for (const call of screenshotCalls) {
      expect(call.maskColor).toBe('#000000');
      expect(call.mask).toHaveLength(2);
    }
  });

  test('renders configured sensitive selectors as black pixels before writing evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-mask-'));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 240, height: 100 } });
      await page.setContent(`
        <style>body{margin:0;background:white} input{position:absolute;left:10px;top:10px;width:180px;height:40px;border:0}</style>
        <input type="password" value="fixture-secret-that-must-not-render" />
      `);
      const policy = structuredClone(DEFAULT_CAPTURE_POLICY);
      policy.loadingSequence.enabled = false;
      policy.contactSheet.enabled = false;
      const capture = new VisualCaptureSession(page, policy, dir, {
        resultKey: 'user-sensitive',
        route: '/sensitive',
        role: 'user',
        browser: 'chromium',
        viewport: '240x100',
        contactSheetMaxPixels: 1_000_000,
        contactSheetMaxBytes: 300_000,
      });
      const output = await capture.finish();
      expect(output.finalScreenshot).not.toBeNull();
      const { data, info } = await sharp(output.finalScreenshot!.path)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const pixel = (30 * info.width + 50) * info.channels;
      expect([...data.subarray(pixel, pixel + 3)]).toEqual([0, 0, 0]);
    } finally {
      await browser.close();
    }
  }, 20_000);

  test('ignores one invalid selector while preserving valid masked evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-invalid-mask-'));
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 240, height: 100 } });
      await page.setContent(`
        <style>body{margin:0;background:white} input{position:absolute;left:10px;top:10px;width:180px;height:40px;border:0}</style>
        <input type="password" value="fixture-secret-that-must-not-render" />
      `);
      const policy = structuredClone(DEFAULT_CAPTURE_POLICY);
      policy.loadingSequence.enabled = false;
      policy.contactSheet.enabled = false;
      policy.maskSelectors.push('[');
      const capture = new VisualCaptureSession(page, policy, dir, {
        resultKey: 'user-invalid-mask', route: '/sensitive', role: 'user', browser: 'chromium',
        viewport: '240x100', contactSheetMaxPixels: 1_000_000, contactSheetMaxBytes: 300_000,
      });
      const output = await capture.finish();
      expect(output.finalScreenshot).not.toBeNull();
      expect(output.warnings.join(' ')).toMatch(/mask selector/);
      const { data, info } = await sharp(output.finalScreenshot!.path)
        .removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = (30 * info.width + 50) * info.channels;
      expect([...data.subarray(pixel, pixel + 3)]).toEqual([0, 0, 0]);
    } finally {
      await browser.close();
    }
  }, 20_000);

  test('capture failures are warnings and do not fail the test result', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-capture-fail-'));
    const page = {
      locator: (selector: string) => ({ selector, count: async () => 1 }),
      screenshot: async () => {
        throw new Error('page already closed');
      },
    };
    const capture = new VisualCaptureSession(page as never, DEFAULT_CAPTURE_POLICY, dir, {
      resultKey: 'user-matrix-test',
      route: '/test',
      role: 'user',
      browser: 'chromium',
      viewport: '120x80',
      contactSheetMaxPixels: 1_000_000,
      contactSheetMaxBytes: 300_000,
    });
    await capture.captureFrame('navigation');
    const output = await capture.finish();
    expect(output.frames).toEqual([]);
    expect(output.finalScreenshot).toBeNull();
    expect(output.contactSheet).toBeNull();
    expect(output.warnings.join(' ')).toMatch(/page already closed/);
    expect(fs.existsSync(output.manifestPath)).toBe(true);
  });
});
