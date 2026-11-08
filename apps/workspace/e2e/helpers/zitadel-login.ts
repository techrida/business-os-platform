import { expect, type Page } from '@playwright/test';

import type { Persona } from './personas';

/**
 * The only place that knows ZITADEL Login V2's markup (risk R8). When a ZITADEL upgrade breaks
 * the persona tests, this is the one file to fix. Selectors are by role and visible label, which
 * the pages expose (checked against the v4.20.1 login on 2026-11-08):
 *   - login name page (`/ui/v2/login/loginname`): label "Loginname", button "Continue"
 *   - password page (`/ui/v2/login/password`):    label "Password",  button "Continue"
 * Both "Continue" buttons are disabled until the field has text.
 *
 * Starting a login with `login_hint` (the switcher links do) makes ZITADEL skip the login name
 * page and open the password page directly, so this handles both starting points.
 */

const loginName = (page: Page) => page.getByLabel(/^\s*login ?name\s*$/i);
const password = (page: Page) => page.getByLabel(/^\s*password\s*$/i);
const continueButton = (page: Page) => page.getByRole('button', { name: /^\s*continue\s*$/i });

/** True while the browser shows a ZITADEL credential form (login name or password). */
export async function expectZitadelCredentialForm(page: Page): Promise<void> {
  await expect(loginName(page).or(password(page))).toBeVisible({ timeout: 30_000 });
}

/**
 * Completes a sign-in for a browser that is already on, or being redirected to, the ZITADEL
 * login. Returns once the browser is back on the app (anywhere but the `/auth/*` plumbing).
 *
 * @param appOrigin origin of the Workspace, e.g. `https://app.localhost`
 */
export async function signInOnZitadel(page: Page, who: Persona, appOrigin: string): Promise<void> {
  await expectZitadelCredentialForm(page);

  if (await loginName(page).isVisible()) {
    await loginName(page).fill(who.username);
    await continueButton(page).click();
  }

  await expect(password(page)).toBeVisible({ timeout: 30_000 });
  await password(page).fill(who.password);
  await continueButton(page).click();

  await page.waitForURL(
    (url) => url.origin === appOrigin && !/^\/auth\/(login|callback|logout)/.test(url.pathname),
    { timeout: 30_000 },
  );
  if (new URL(page.url()).pathname === '/auth/error') {
    throw new Error(`Sign-in for "${who.key}" ended on /auth/error: ${page.url()}`);
  }
}
