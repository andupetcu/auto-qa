import { expect, test as setup } from '@playwright/test';
import { SEL } from './selectors';

const roles = (process.env.QA_ROLES ?? 'user,anon').split(',')
  .map(r => r.trim()).filter(r => r !== 'anon');

setup.setTimeout(120_000);

async function loginOnce(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto(SEL.loginPath);
  const emailInput = page.locator(SEL.loginEmail);
  // the login modal loads its form asynchronously ("Loading secure form…") and the
  // form re-renders for a moment after appearing — wait, then let it settle
  await expect(emailInput).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await emailInput.fill(email, { timeout: 10_000 });
  await page.locator(SEL.loginPassword).fill(password, { timeout: 10_000 });
  await page.getByRole('button', { name: SEL.loginSubmitName, exact: true }).click();
  // success: the login form goes away and the app shell renders (URL does not change)
  await expect(page.locator(SEL.loginPassword)).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(SEL.appShell).first()).toBeVisible({ timeout: 20_000 });
}

for (const role of roles) {
  setup(`authenticate ${role}`, async ({ page }) => {
    const P = `QA_CRED_${role.toUpperCase()}`;
    const email = process.env[`${P}_EMAIL`];
    const password = process.env[`${P}_PASSWORD`];
    if (!email || !password) throw new Error(`missing ${P}_EMAIL / ${P}_PASSWORD`);

    // the app under test occasionally crashes to its error boundary during login
    // hydration; one full reload-and-retry keeps that from failing the whole run
    try {
      await loginOnce(page, email, password);
    } catch (first) {
      await page.reload();
      await loginOnce(page, email, password);
    }
    await page.context().storageState({ path: `.auth/${role}.json` });
  });
}
