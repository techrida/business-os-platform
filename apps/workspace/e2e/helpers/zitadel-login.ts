import { expect, type Locator, type Page } from '@playwright/test';

import type { Persona } from './personas';

/**
 * Credential selectors for stock ZITADEL Login V2 and the Business OS login image.
 * Stock v4.20.1 varies the login-name label by policy. The branded form uses "Email or username".
 *
 * Starting a login with `login_hint` (the switcher links do) makes ZITADEL skip the login name
 * page and open the password page directly, so this handles both starting points.
 */

const loginName = (page: Page) =>
  page.getByLabel(
    /^\s*(login ?name|username(?: or (?:email|phone number))?|email or username)\s*$/i,
  );
const password = (page: Page) => page.getByLabel(/^\s*password\s*$/i);
const continueButton = (page: Page) => page.getByRole('button', { name: /^\s*continue\s*$/i });

async function submitCredential(page: Page, field: Locator, value: string): Promise<void> {
  const submit = continueButton(page);
  // The server-rendered input can accept text before Login V2 starts handling input events.
  // Retry entry until the form acknowledges it. Click only once, after it becomes enabled.
  await expect(async () => {
    await field.clear();
    await field.fill(value);
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await submit.click();
}

/** Wait for a credential screen, choosing a remembered account first when supplied after logout. */
export async function expectZitadelCredentialForm(page: Page, account?: Persona): Promise<void> {
  const credentials = loginName(page).or(password(page));
  if (account) {
    const chooser = page.getByRole('heading', {
      name: /^(Accounts|Choose an account)$/i,
      level: 1,
    });
    await expect(chooser.or(credentials)).toBeVisible({ timeout: 30_000 });
    if (await chooser.isVisible()) {
      const name = account.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
    }
  }
  await expect(credentials).toBeVisible({ timeout: 30_000 });
}

/** Submit a real code in phases that enroll personas in authenticator verification. */
export async function submitZitadelOtp(page: Page, input: Locator, code: string): Promise<void> {
  // input-otp owns the six-slot field. Read its marker before filling, since filling can navigate.
  const autoSubmits = (await input.getAttribute('data-input-otp')) !== null;
  await input.fill(code);
  if (autoSubmits) return;

  const submit = page
    .getByRole('button', {
      name: /^\s*(continue|verify and continue|verify|submit|next|authenticate)\s*$/i,
    })
    .first();
  if (await submit.isVisible()) await submit.click();
  else await input.press('Enter');
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
    await submitCredential(page, loginName(page), who.username);
  }

  await expect(password(page)).toBeVisible({ timeout: 30_000 });
  await submitCredential(page, password(page), who.password);

  await page.waitForURL(
    (url) => url.origin === appOrigin && !/^\/auth\/(login|callback|logout)/.test(url.pathname),
    { timeout: 30_000 },
  );
  if (new URL(page.url()).pathname === '/auth/error') {
    throw new Error(`Sign-in for "${who.key}" ended on /auth/error: ${page.url()}`);
  }
}
