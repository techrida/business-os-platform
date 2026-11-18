import { expect, type Locator, type Page } from '@playwright/test';
import { generate } from 'otplib';

import type { Persona } from './personas';

/**
 * Credential selectors for stock ZITADEL Login V2 and the Business OS login image.
 * Stock v4.20.1 varies the login-name label by policy. The branded form uses "Email or username".
 *
 * Starting a login with `login_hint` (the switcher links do) makes ZITADEL skip the login name
 * page and open the password page directly, so this handles both starting points.
 *
 * Second factor (P1 turns on forceMfa, so every persona has a TOTP): after the password step the
 * login shows an authenticator-code page. Its selectors are NOT verified against a live v4 login
 * yet, so the page is recognised by several independent signals (see `findOtpInput`); if the real
 * UI differs, `findOtpInput` and `looksLikeTotpSetup` are the two places to adjust.
 */

const loginName = (page: Page) =>
  page.getByLabel(
    /^\s*(login ?name|username(?: or (?:email|phone number))?|email or username)\s*$/i,
  );
const password = (page: Page) => page.getByLabel(/^\s*password\s*$/i);
const continueButton = (page: Page) => page.getByRole('button', { name: /^\s*continue\s*$/i });

/** The same fix for every "no code available" failure, so the message is greppable. */
const NO_TOTP = (who: Persona, detail: string): Error =>
  new Error(
    `Persona "${who.key}" has no TOTP registered; run pnpm seed (${detail}). ` +
      'The e2e login never registers an authenticator itself.',
  );

/** Matches the visible words of an authenticator-code page (heading or body text). */
const OTP_TEXT = /authenticator|one-time|verify|2-factor|two-factor/i;

/** Matches the visible words of the "add a second factor" page that appears when none exists. */
const SETUP_TEXT =
  /(set ?up|register|add|configure|enable)\b.{0,40}(authenticator|2-factor|two-factor|second factor|multi-factor|mfa)/i;

const TOTP_PERIOD_S = 30;
/** If fewer seconds than this remain in the window, wait for the next one before generating. */
const TOTP_MIN_REMAINING_S = 3;

/** The TOTP window each secret last produced a code in during this worker's lifetime. */
const lastWindowBySecret = new Map<string, number>();
const currentTotpWindow = (nowMs: number = Date.now()): number =>
  Math.floor(nowMs / 1000 / TOTP_PERIOD_S);

/** Seconds left in the current 30 s TOTP window (RFC 6238 counts windows from the Unix epoch). */
export function secondsLeftInTotpWindow(nowMs: number = Date.now()): number {
  return TOTP_PERIOD_S - ((nowMs / 1000) % TOTP_PERIOD_S);
}

/**
 * A code ZITADEL will still accept after the browser has submitted it. A code generated in the
 * last couple of seconds of a window can expire in flight, so this waits for the next window then.
 * On a worker's first use, also wait: Playwright restarts workers after failures, while ZITADEL
 * still remembers the previous worker's consumed code. Starting a fresh window avoids that replay.
 * SHA-1, 6 digits and 30 s are ZITADEL's fixed TOTP parameters, spelled out so a future change in
 * the library's defaults cannot silently break the logins.
 */
export async function freshTotpCode(secret: string, page: Page): Promise<string> {
  const normalized = secret.replace(/\s+/g, '').toUpperCase();
  const left = secondsLeftInTotpWindow();
  const previous = lastWindowBySecret.get(normalized);
  // ZITADEL accepts each code once: a persona that signs in twice inside one 30 s window (the exit
  // spec, then the inbox spec) would send a used code and stall on the OTP page. Wait it out.
  if (previous === undefined || previous === currentTotpWindow() || left < TOTP_MIN_REMAINING_S) {
    await page.waitForTimeout(Math.ceil(left * 1000) + 250);
  }
  lastWindowBySecret.set(normalized, currentTotpWindow());
  return generate({
    secret: normalized,
    strategy: 'totp',
    algorithm: 'sha1',
    digits: 6,
    period: TOTP_PERIOD_S,
  });
}

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
      const rememberedAccount = page.getByRole('button').filter({ hasText: account.username });
      // The chooser can render before the login form handles its first click.
      await expect(async () => {
        if (await chooser.isVisible()) await rememberedAccount.click({ timeout: 2_000 });
        await expect(credentials).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
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
 * The TOTP code field of the second-factor page, or null when it is not showing. Strategy, most
 * specific first:
 *   1. `autocomplete="one-time-code"` (what a well-formed OTP field declares),
 *   2. an input whose `name` or `id` contains "code",
 *   3. the only visible text-like input, when the page's heading or text reads like an
 *      authenticator prompt (/authenticator|one-time|verify|2-factor|two-factor/).
 * Signal 3 is skipped on the credential forms so a password field is never mistaken for a code.
 */
async function findOtpInput(page: Page): Promise<Locator | null> {
  const declared = page
    .locator('input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i]')
    .filter({ visible: true })
    .first();
  if (await declared.isVisible()) return declared;

  if ((await loginName(page).isVisible()) || (await password(page).isVisible())) return null;
  const prompt = page.getByRole('heading', { name: OTP_TEXT }).or(page.getByText(OTP_TEXT)).first();
  if (!(await prompt.isVisible())) return null;
  const inputs = page.locator(
    'input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"])',
  );
  const visible = await inputs.filter({ visible: true }).all();
  return visible.length === 1 ? (visible[0] as Locator) : null;
}

/** True on ZITADEL's "set up a second factor" page (by path or by its heading/button words). */
async function looksLikeTotpSetup(page: Page): Promise<boolean> {
  if (/\/(mfa|otp|u2f)(\/[^/]+)*\/set\b/i.test(new URL(page.url()).pathname)) return true;
  const heading = page.getByRole('heading', { name: SETUP_TEXT });
  return heading.first().isVisible();
}

type LoginState = 'app' | 'otp' | 'setup' | 'pending';

async function classify(page: Page, appOrigin: string): Promise<LoginState> {
  const url = new URL(page.url());
  if (url.origin === appOrigin && !/^\/auth\/(login|callback|logout)/.test(url.pathname)) {
    return 'app';
  }
  if (url.origin === appOrigin) return 'pending';
  // The setup page can also contain a code field (the QR confirmation), so it is checked first.
  if (await looksLikeTotpSetup(page)) return 'setup';
  if ((await findOtpInput(page)) !== null) return 'otp';
  return 'pending';
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

  // After the password ZITADEL goes to one of: the authenticator-code page (expected), the
  // "set up 2FA" page (the seed did not register TOTP), or straight back to the app (MFA off).
  // Poll until one shows; the redirect chain can take a few seconds.
  let otpDone = false;
  let deadline = Date.now() + 30_000;
  for (;;) {
    const state = await classify(page, appOrigin);
    if (state === 'app') break;
    if (state === 'setup') throw NO_TOTP(who, 'ZITADEL asked this user to set up a second factor');
    if (state === 'otp' && !otpDone) {
      if (who.totpSecret === undefined) {
        throw NO_TOTP(who, 'ZITADEL asks for a code but .dev/personas.json has no totpSecret');
      }
      const input = await findOtpInput(page);
      // null: the page re-rendered between classify and now; the next loop turn looks again.
      if (input !== null) {
        // The bounded wait for a fresh code is deliberate, not time spent waiting on the UI.
        const waitingSince = Date.now();
        const code = await freshTotpCode(who.totpSecret, page);
        deadline += Date.now() - waitingSince;
        await submitZitadelOtp(page, input, code);
        otpDone = true;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Sign-in for "${who.key}" did not reach the app within 30 s, excluding the fresh-code wait ` +
          `(last path ${new URL(page.url()).pathname}, code ${otpDone ? 'submitted' : 'not requested'})`,
      );
    }
    await page.waitForTimeout(250);
  }

  if (new URL(page.url()).pathname === '/auth/error') {
    throw new Error(`Sign-in for "${who.key}" ended on /auth/error`);
  }
}
