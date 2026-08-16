/**
 * @fileoverview Verifies deterministic visual artifact generation and manifest
 * binding to the filenames assigned by Playwright's attachment transport.
 */
import { describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import {
  buildVisualManifest,
  createContactSheet,
  describeFrameFile,
} from '../src/visual/artifacts';
import { bindVisualManifestAttachmentNames } from '../src/lib/attachments';

describe('visual evidence artifacts', () => {
  test('builds a bounded readable contact sheet and versioned hash manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-visual-'));
    const firstPath = path.join(dir, 'frame-00-navigation.png');
    const secondPath = path.join(dir, 'frame-01-asserted.png');
    await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#c03030' },
    }).png().toFile(firstPath);
    await sharp({
      create: { width: 390, height: 844, channels: 3, background: '#3050c0' },
    }).png().toFile(secondPath);

    const frames = [
      await describeFrameFile(firstPath, 0, 'navigation', '2026-08-15T08:00:00.000Z'),
      await describeFrameFile(secondPath, 1, 'asserted', '2026-08-15T08:00:01.000Z'),
    ];
    const sheetPath = path.join(dir, 'contact-sheet.webp');
    const sheet = await createContactSheet(frames, sheetPath, {
      quality: 80,
      maxPixels: 2_000_000,
      maxBytes: 500_000,
      labels: {
        route: '/campaigns/reports',
        role: 'user',
        browser: 'chromium',
        viewport: '800x600',
      },
    });

    const metadata = await sharp(sheetPath).metadata();
    expect(metadata.format).toBe('webp');
    expect((metadata.width ?? 0) * (metadata.height ?? 0)).toBeLessThanOrEqual(2_000_000);
    expect(sheet.bytes).toBeLessThanOrEqual(500_000);
    expect(sheet.sha256).toMatch(/^[a-f0-9]{64}$/);

    const manifest = buildVisualManifest({
      resultKey: 'user-matrix-campaigns-reports',
      route: '/campaigns/reports',
      role: 'user',
      browser: 'chromium',
      viewport: '800x600',
      policyVersion: 1,
      frames,
      finalScreenshot: frames[1],
      contactSheet: sheet,
      warnings: [],
    });

    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.evidenceState).toBe('captured_unsettled');
    expect(manifest.readiness).toBeNull();
    expect(manifest.resultId).toBeNull();
    expect(manifest.frames.map((frame) => frame.index)).toEqual([0, 1]);
    expect(manifest.frames[0].sha256).not.toBe(manifest.frames[1].sha256);
    expect(manifest.contactSheet?.sha256).toBe(sheet.sha256);
    expect(manifest.capturePolicyVersion).toBe(1);
  });

  test('deduplication identity is the frame sha256, not filename', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-frame-'));
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    const pixels = await sharp({
      create: { width: 20, height: 20, channels: 3, background: '#101010' },
    }).png().toBuffer();
    fs.writeFileSync(a, pixels);
    fs.writeFileSync(b, pixels);

    const first = await describeFrameFile(a, 0, 'navigation', '2026-08-15T08:00:00.000Z');
    const second = await describeFrameFile(b, 1, 'asserted', '2026-08-15T08:00:01.000Z');
    expect(first.sha256).toBe(second.sha256);
  });

  test('binds manifest descriptors to Playwright attachment filenames', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-manifest-bind-'));
    const capturePath = path.join(dir, 'final-screenshot.png');
    const sheetCapturePath = path.join(dir, 'contact-sheet.webp');
    await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#202020' },
    }).png().toFile(capturePath);
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#303030' },
    }).webp().toFile(sheetCapturePath);
    const final = await describeFrameFile(
      capturePath,
      0,
      'asserted',
      '2026-08-15T08:00:00.000Z',
    );
    const sheetBuffer = fs.readFileSync(sheetCapturePath);
    const sheetMetadata = await sharp(sheetBuffer).metadata();
    const sheet = {
      filename: path.basename(sheetCapturePath),
      bytes: sheetBuffer.length,
      sha256: crypto.createHash('sha256').update(sheetBuffer).digest('hex'),
      width: sheetMetadata.width ?? 0,
      height: sheetMetadata.height ?? 0,
    };
    const manifest = buildVisualManifest({
      resultKey: 'user-matrix-home',
      route: '/',
      role: 'user',
      browser: 'chromium',
      viewport: '40x30',
      policyVersion: 1,
      frames: [final],
      finalScreenshot: final,
      contactSheet: sheet,
      warnings: [],
    });

    const screenshotAttachment = path.join(dir, 'screenshot-content-addressed.png');
    const sheetAttachment = path.join(dir, 'contact-sheet-content-addressed.webp');
    const manifestAttachment = path.join(dir, 'visual-manifest-content-addressed.json');
    fs.copyFileSync(capturePath, screenshotAttachment);
    fs.copyFileSync(sheetCapturePath, sheetAttachment);
    fs.writeFileSync(manifestAttachment, JSON.stringify(manifest));

    bindVisualManifestAttachmentNames([
      { name: 'screenshot', path: screenshotAttachment },
      { name: 'contact_sheet', path: sheetAttachment },
      { name: 'visual_manifest', path: manifestAttachment },
    ]);

    const rebound = JSON.parse(fs.readFileSync(manifestAttachment, 'utf8'));
    expect(rebound.finalScreenshot.filename).toBe(path.basename(screenshotAttachment));
    expect(rebound.contactSheet.filename).toBe(path.basename(sheetAttachment));
  });

  test('rejects impossible contact-sheet pixel and byte budgets instead of exceeding policy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-contact-bounds-'));
    const framePath = path.join(dir, 'frame.png');
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#445566' } })
      .png().toFile(framePath);
    const frame = await describeFrameFile(framePath, 0, 'asserted', '2026-08-15T08:00:00.000Z');
    await expect(createContactSheet([frame], path.join(dir, 'pixels.webp'), {
      quality: 80, maxPixels: 1, maxBytes: 500_000,
      labels: { route: '/', role: 'user', browser: 'chromium', viewport: '800x600' },
    })).rejects.toThrow(/feasible minimum/);
    await expect(createContactSheet([frame], path.join(dir, 'bytes.webp'), {
      quality: 80, maxPixels: 2_000_000, maxBytes: 1,
      labels: { route: '/', role: 'user', browser: 'chromium', viewport: '800x600' },
    })).rejects.toThrow(/bounded encoding/);
  });

  test('contact-sheet bytes are deterministic for identical inputs and labels', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-contact-determinism-'));
    const framePath = path.join(dir, 'frame.png');
    await sharp({ create: { width: 120, height: 80, channels: 3, background: '#112233' } })
      .png().toFile(framePath);
    const frame = await describeFrameFile(framePath, 0, 'asserted', '2026-08-15T08:00:00.000Z');
    const options = {
      quality: 80, maxPixels: 2_000_000, maxBytes: 500_000,
      labels: { route: '/same', role: 'user', browser: 'chromium', viewport: '120x80' },
    };
    const first = await createContactSheet([frame], path.join(dir, 'first.webp'), options);
    const second = await createContactSheet([frame], path.join(dir, 'second.webp'), options);
    expect(first.sha256).toBe(second.sha256);
    expect(fs.readFileSync(path.join(dir, 'first.webp'))).toEqual(fs.readFileSync(path.join(dir, 'second.webp')));
  });

  test('rejects ambiguous and mismatched transport attachment identities', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-qa-bind-negative-'));
    const bytes = Buffer.from('same-visual-bytes');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      schemaVersion: 1, resultId: null, frames: [], contactSheet: null, warnings: [],
      finalScreenshot: { filename: 'logical.png', bytes: bytes.length, sha256: digest, width: 1, height: 1 },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    const first = path.join(dir, 'first.png');
    const second = path.join(dir, 'second.png');
    fs.writeFileSync(first, bytes);
    fs.writeFileSync(second, bytes);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => bindVisualManifestAttachmentNames([
      { name: 'screenshot', path: first }, { name: 'screenshot', path: second },
      { name: 'visual_manifest', path: manifestPath },
    ])).toThrow(/exactly one/);

    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      finalScreenshot: { ...manifest.finalScreenshot, sha256: '0'.repeat(64) },
    }));
    expect(() => bindVisualManifestAttachmentNames([
      { name: 'screenshot', path: first }, { name: 'visual_manifest', path: manifestPath },
    ])).toThrow(/exactly one/);
  });
});
