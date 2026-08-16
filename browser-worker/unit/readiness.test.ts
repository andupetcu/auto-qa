/**
 * @fileoverview Real-browser tests for application-agnostic readiness, lifecycle
 * capture, and critical request verdicts.
 */
import { chromium } from '@playwright/test';
import { describe, expect, test } from 'vitest';

import { DEFAULT_READINESS_POLICY } from '../src/visual/policy';
import { isCriticalRequest, ReadinessMonitor, requestMatchesRule } from '../src/visual/readiness';

describe('readiness request classification', () => {
  test('uses safe globs and lets ignored rules win', () => {
    const input = { url: 'https://app.test/api/chart?id=secret', method: 'POST', resourceType: 'fetch' };
    expect(requestMatchesRule(input, { urlGlob: 'https://app.test/api/*', methods: ['POST'], resourceTypes: ['fetch'] })).toBe(true);
    const policy = structuredClone(DEFAULT_READINESS_POLICY);
    policy.ignoredRequests = [{ urlGlob: '*/api/chart*', methods: [], resourceTypes: ['fetch'] }];
    expect(isCriticalRequest(input, policy)).toBe(false);
  });
});

describe('ReadinessMonitor', () => {
  test('captures loading and response milestones before visual settlement', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await page.route('**/api/data', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: '{"ok":true}',
        });
      });
      const captures: string[] = [];
      const policy = structuredClone(DEFAULT_READINESS_POLICY);
      Object.assign(policy, {
        timeoutMs: 3000, pollIntervalMs: 50, captureIntervalMs: 100,
        stabilityWindowMs: 100, loadingSelectors: ['#loading'],
      });
      const monitor = new ReadinessMonitor(page, policy, async (milestone) => { captures.push(milestone); });
      await page.setContent(`
        <div id="loading">Loading</div><main></main>
        <script>fetch('https://app.test/api/data').then(() => document.querySelector('#loading').remove())</script>
      `);
      const summary = await monitor.assess();
      monitor.stop();
      expect(summary.status).toBe('passed');
      expect(summary.criticalRequestsStarted).toBe(1);
      expect(summary.criticalRequestsCompleted).toBe(1);
      expect(summary.pendingCriticalRequests).toBe(0);
      expect(captures).toContain('loading');
      expect(captures).toContain('critical-response');
      expect(captures.at(-1)).toBe('settled');
    } finally {
      await browser.close();
    }
  }, 10_000);

  test('times out with pending critical requests while retaining lifecycle capture', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
      await page.route('**/api/stuck', async () => new Promise(() => undefined));
      const captures: string[] = [];
      const policy = structuredClone(DEFAULT_READINESS_POLICY);
      Object.assign(policy, { timeoutMs: 300, pollIntervalMs: 50, captureIntervalMs: 75, stabilityWindowMs: 50 });
      const monitor = new ReadinessMonitor(page, policy, async (milestone) => { captures.push(milestone); });
      await page.setContent(`<main>Loading</main><script>fetch('https://app.test/api/stuck')</script>`);
      const summary = await monitor.assess();
      monitor.stop();
      expect(summary.status).toBe('timed_out');
      expect(summary.pendingCriticalRequests).toBe(1);
      expect(summary.reasons.join(' ')).toMatch(/critical request/);
      expect(captures.filter((value) => value === 'loading').length).toBeGreaterThan(1);
      expect(captures.at(-1)).toBe('timeout');
    } finally {
      await browser.close();
    }
  }, 10_000);

  test('classifies unavailable visual sampling without throwing away readiness evidence', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const policy = structuredClone(DEFAULT_READINESS_POLICY);
      Object.assign(policy, { timeoutMs: 250, pollIntervalMs: 50 });
      const monitor = new ReadinessMonitor(page, policy, async () => undefined);
      await page.close();
      const summary = await monitor.assess();
      monitor.stop();
      expect(summary.status).toBe('timed_out');
      expect(summary.reasons).toContain('visual stability sampling unavailable');
    } finally {
      await browser.close();
    }
  });

  test('fails fast on a definitive critical HTTP failure', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route('https://app.test/', async (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: '<main>ready</main>',
      }));
      await page.route('**/api/fail', async (route) => route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'failed',
      }));
      const policy = structuredClone(DEFAULT_READINESS_POLICY);
      Object.assign(policy, { timeoutMs: 1_000, pollIntervalMs: 50 });
      const monitor = new ReadinessMonitor(page, policy, async () => undefined);
      await page.goto('https://app.test/');
      await page.evaluate(() => fetch('/api/fail').then((response) => response.text()));
      await page.waitForTimeout(50);
      const summary = await monitor.assess();
      monitor.stop();
      expect(summary.status).toBe('failed');
      expect(summary.elapsedMs).toBeLessThan(policy.timeoutMs);
      expect(summary.criticalRequestFailures[0]?.status).toBe(500);
      expect(summary.reasons).toContain('1 critical request failure(s)');
    } finally {
      await browser.close();
    }
  });

  test('fails fast on an invalid immutable readiness selector', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const policy = structuredClone(DEFAULT_READINESS_POLICY);
      Object.assign(policy, {
        timeoutMs: 1_000,
        pollIntervalMs: 50,
        loadingSelectors: ['['],
      });
      const monitor = new ReadinessMonitor(page, policy, async () => undefined);
      const summary = await monitor.assess();
      monitor.stop();
      expect(summary.status).toBe('failed');
      expect(summary.elapsedMs).toBeLessThan(policy.timeoutMs);
      expect(summary.reasons).toContain('1 readiness selector(s) invalid');
    } finally {
      await browser.close();
    }
  });

  test('console errors participate in the readiness verdict', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const policy = structuredClone(DEFAULT_READINESS_POLICY);
      Object.assign(policy, { timeoutMs: 200, pollIntervalMs: 50, stabilityWindowMs: 0 });
      const monitor = new ReadinessMonitor(page, policy, async () => undefined);
      await page.setContent('<script>console.error("runtime boom")</script>');
      const summary = await monitor.assess();
      monitor.stop();
      expect(summary.status).toBe('failed');
      expect(summary.elapsedMs).toBeLessThan(policy.timeoutMs);
      expect(summary.runtimeErrors[0]).toMatchObject({ kind: 'console', level: 'error' });
      expect(summary.reasons).toContain('console error captured');
    } finally {
      await browser.close();
    }
  }, 10_000);
});
