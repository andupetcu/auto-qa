import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';

type Capture = { consolePath: string };

// Every spec imports { test, expect } from here so console + HAR capture is universal.
export const test = base.extend<Capture>({
  context: async ({ browser }, use, testInfo) => {
    const harPath = testInfo.outputPath('network.har');
    const context = await browser.newContext({
      storageState: testInfo.project.use.storageState as string | undefined,
      recordHar: {
        path: harPath,
        mode: 'minimal',
        urlFilter: new RegExp(process.env.QA_HAR_URL_FILTER ?? '.*'),
      },
    });
    await use(context);
    await context.close(); // flushes the HAR
    if (fs.existsSync(harPath)) {
      await testInfo.attach('har', { path: harPath, contentType: 'application/json' });
    }
  },
  consolePath: [async ({ page }, use, testInfo) => {
    const p = testInfo.outputPath('console.jsonl');
    const w = fs.createWriteStream(p);
    const write = (o: object) => w.write(JSON.stringify({ t: Date.now(), ...o }) + '\n');
    page.on('console', m => write({
      kind: 'console', level: m.type() === 'warning' ? 'warning' : m.type(),
      text: m.text(), loc: m.location(),
    }));
    page.on('pageerror', e => write({
      kind: 'pageerror', level: 'error', text: e.message, stack: e.stack,
    }));
    page.on('requestfailed', r => write({
      kind: 'requestfailed', level: 'error',
      text: r.failure()?.errorText ?? 'request failed', url: r.url(),
    }));
    // AUTH_EXPIRED sentinel (arch §3.2): a 401 on a same-origin API call while running
    // with a storageState means the session went stale mid-run, not an app bug.
    const authed = Boolean(testInfo.project.use.storageState);
    page.on('response', resp => {
      if (authed && resp.status() === 401
          && resp.url().startsWith(process.env.QA_RUN_BASE_URL ?? process.env.QA_BASE_URL_DEFAULT ?? '')) {
        fs.writeFileSync(testInfo.outputPath('..', 'AUTH_EXPIRED'), resp.url());
      }
    });
    await use(p);
    w.end();
    await new Promise<void>(res => w.on('finish', () => res()));
    if (fs.existsSync(p)) {
      await testInfo.attach('console', { path: p, contentType: 'application/jsonl' });
    }
  }, { auto: true }],
});

export { expect };
