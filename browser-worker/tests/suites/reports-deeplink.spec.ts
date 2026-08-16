/** @fileoverview Authenticated reports deep-link contract with explicit role applicability. */
import { expect, test } from '../fixtures';
import { SEL } from '../selectors';

// Deep link with the seeded fixture campaign (owner-supplied). Authenticated only.
const QUERY = process.env.QA_FIXTURE_REPORTS_QUERY
  ?? 'startDate=2026-06-09&endDate=2026-06-09&channel=digitalSignage'
     + '&campaignId=6a27f8b29619ed3e56138cd8&reportingType=dayReport';

test('reports deeplink renders for seeded campaign as user -> render', async ({ page }) => {
  test.skip((process.env.QA_RUN_PROJECT ?? 'fai') !== 'fai', 'fai-specific suite');
  test.info().annotations.push({ type: 'route', description: '/campaigns/reports' });

  await page.goto(`/campaigns/reports?${QUERY}`);
  await expect(page.locator(SEL.appShell).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(SEL.gateText)).toHaveCount(0);
});
