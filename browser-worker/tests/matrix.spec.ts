import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { expect, test } from './fixtures';
import { SEL } from './selectors';
import { parseListEnv, resolveMatrix } from './projectConfig';

type Expected = 'render' | 'redirect' | 403;
const here = path.dirname(fileURLToPath(import.meta.url));
const loadYamlFallback = () =>
  yaml.parse(fs.readFileSync(path.join(here, 'role-matrix.yaml'), 'utf8'));
const matrix = resolveMatrix(process.env, loadYamlFallback) as Record<string, Record<string, Expected>>;

const requestedRoutes = parseListEnv(process.env.QA_RUN_ROUTES);
const requestedRoles = parseListEnv(process.env.QA_RUN_ROLES);

const resolveParams = (route: string) =>
  route.replace(/:(\w+)/g, (_, p) => process.env[`QA_FIXTURE_${p.toUpperCase()}`] ?? '1');

for (const [route, expectations] of Object.entries(matrix)) {
  if (requestedRoutes && !requestedRoutes.includes('ALL') && !requestedRoutes.includes(route)) continue;
  for (const [role, expected] of Object.entries(expectations)) {
    if (requestedRoles && !requestedRoles.includes(role)) continue;

    test(`matrix ${route} as ${role} -> ${expected}`, async ({ page }) => {
      test.skip(test.info().project.name !== role, `runs in the ${role} project only`);

      await page.goto(resolveParams(route));

      if (expected === 'render') {
        await expect(page.locator(SEL.appShell).first()).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(SEL.gateText)).toHaveCount(0);
      } else if (expected === 'redirect') {
        // SPA client-side gate: gate text OR login form OR ?auth=login — no HTTP redirect
        await expect
          .poll(async () => {
            if (page.url().includes('auth=login')) return true;
            if (await page.getByText(SEL.gateText).count()) return true;
            if (await page.locator(SEL.loginPassword).count()) return true;
            return false;
          }, { timeout: 20_000, message: 'expected client-side auth gate' })
          .toBe(true);
      } else {
        await expect(page.getByText(/forbidden|not allowed|403/i).first())
          .toBeVisible({ timeout: 20_000 });
      }
    });
  }
}
