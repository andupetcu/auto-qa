/** @fileoverview Authenticated reports deep-link contract with explicit role applicability. */
import { expect, test } from '../fixtures';
import { SEL } from '../selectors';

// Deep link with a seeded fixture (owner-supplied via env). Authenticated only.
const QUERY = process.env.QA_FIXTURE_REPORTS_QUERY
  ?? 'startDate=2026-06-09&endDate=2026-06-09&channel=default'
     + '&entityId=000000000000000000000000&reportingType=dayReport';

test('reports deeplink renders for seeded entity as user -> render', async ({ page }) => {
  test.skip(!process.env.QA_FIXTURE_REPORTS_QUERY, 'requires QA_FIXTURE_REPORTS_QUERY env');
  test.info().annotations.push({ type: 'route', description: '/dashboard/reports' });

  await page.goto(`/dashboard/reports?${QUERY}`);
  await expect(page.locator(SEL.appShell).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(SEL.gateText)).toHaveCount(0);
});
