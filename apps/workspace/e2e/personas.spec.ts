import { expect, test } from '@playwright/test';

import { PERSONA_KEYS, loadPersonas, persona } from './helpers/personas';
import { expectZitadelCredentialForm, signInOnZitadel } from './helpers/zitadel-login';

/**
 * Each seeded persona signs in through the real ZITADEL Login V2 form (password, then a
 * TOTP code from the seed's secret) and the Workspace's real OIDC code flow. Nothing is stubbed: no token, header or cookie is faked anywhere.
 */

const SESSION_COOKIE = process.env.BOS_E2E_SESSION_COOKIE ?? '__Host-bos_session';
const authOrigin = process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost';

// A login answered with 429 (CR-03) makes a sign-in look broken for no reason in the app. Name it
// in the test that hit it: every `/auth/login` response is checked, whichever step caused it.
test.beforeEach(({ page, baseURL }) => {
  const appOrigin = new URL(baseURL ?? '').origin;
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.origin === appOrigin && url.pathname === '/auth/login' && res.status() === 429) {
      test.info().annotations.push({ type: 'rate-limited', description: res.url() });
    }
  });
});

test.afterEach(() => {
  const limited = test.info().annotations.filter((a) => a.type === 'rate-limited');
  expect(
    limited,
    'Workspace login rate limit (CR-03) answered 429: 20 logins per minute per client IP; ' +
      'all local traffic shares one IP through Caddy. Run fewer tests per minute (lower --repeat-each or --workers).',
  ).toHaveLength(0);
});

// Read at collection time, so a missing `.dev/personas.json` fails loudly with "run pnpm seed".
const personas = loadPersonas();

test.describe('seeded personas', () => {
  // P1 added the accountant (blueprint base route Accountant -> Finance); P4 added procurement, warehouse,
  // depthead, management2 and finance2; the sales and marketing line added six more. A stale file from an older `pnpm seed` fails here, with a clear message,
  // instead of deep inside a ZITADEL login.
  test('the seed wrote exactly the eighteen personas, accountant included', () => {
    expect(personas.map((p) => p.key).sort()).toEqual([...PERSONA_KEYS].sort());
    const accountant = persona('accountant');
    expect(accountant.role).toBe('accountant');
    expect(accountant.orgKind).toBe('staff');
    expect(accountant.username).toBe('accountant@dev.bos.test');
  });

  test('every persona has a TOTP secret, because the login policy forces MFA', () => {
    const without = personas.filter((p) => !p.totpSecret).map((p) => p.key);
    expect(without, 'no totpSecret for these personas; run pnpm seed').toEqual([]);
  });
});

test('branded sign-in exposes the product name and accepts a real persona', async ({
  page,
  baseURL,
}) => {
  test.skip(
    process.env.BOS_E2E_BRANDED_LOGIN !== '1',
    'set BOS_E2E_BRANDED_LOGIN=1 when testing the Business OS login image',
  );

  const appOrigin = new URL(baseURL ?? '').origin;
  await page.goto('/');
  await expect(page).toHaveURL((url) => url.origin === authOrigin);
  // The sign-in page streams behind a loading shell, so the lockup can exist twice for a moment.
  await expect(page.getByText('Business OS', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Email or username', { exact: true })).toBeVisible();

  await signInOnZitadel(page, persona('sales'), appOrigin);
  await expect(page).toHaveURL(`${appOrigin}/`);
  const cookies = await page.context().cookies(appOrigin);
  expect(cookies.some((cookie) => cookie.name === SESSION_COOKIE && cookie.value !== '')).toBe(
    true,
  );
});

test.describe('persona sign-in and sign-out', () => {
  for (const who of personas) {
    test(`${who.key} (${who.orgKind}) signs in, lands in the right place, and sign-out ends the session`, async ({
      page,
      baseURL,
    }) => {
      const appOrigin = new URL(baseURL ?? '').origin;

      await test.step('visiting / without a session starts the login', async () => {
        await page.goto('/');
        // The real redirect chain ends on ZITADEL, not on the app.
        await expect(page).toHaveURL((url) => url.origin === authOrigin);
        await signInOnZitadel(page, who, appOrigin);
      });

      await test.step('lands where the organisation kind says', async () => {
        if (who.orgKind === 'staff') {
          await expect(page).toHaveURL(`${appOrigin}/`);
          // The greeting uses the display name from /v1/me (`Good morning, Dev`); `Welcome back` without one.
          await expect(
            page.getByRole('heading', {
              name: /^(Welcome back|Good (morning|afternoon|evening)(, .+)?)$/,
            }),
          ).toBeVisible();
          // The header shows the roles that came from the token.
          const header = page.getByRole('banner');
          await expect(header).toContainText(new RegExp(who.role.replace(/[_-]/g, ' '), 'i'));
        } else {
          // A valid session, but not for this app: `/` sends customers and vendors away.
          await expect(page).toHaveURL(`${appOrigin}/staff-only`);
          await expect(
            page.getByRole('heading', { name: 'This is the staff workspace' }),
          ).toBeVisible();
          await page.goto('/');
          await expect(page).toHaveURL(`${appOrigin}/staff-only`);
        }
        const cookies = await page.context().cookies(appOrigin);
        expect(cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '')).toBe(true);
      });

      await test.step('sign out ends the session', async () => {
        // The chain after the click is: POST /auth/logout, ZITADEL end_session, back to
        // `${appOrigin}/` (the post_logout_redirect_uri), then `/` sends the cookie-less browser
        // to /auth/login and on to ZITADEL. Both waits start before the click so neither is missed.
        // The navigation to exactly `${appOrigin}/` proves ZITADEL processed end_session. Asking
        // for `/` again by hand would abort that chain, and if end_session had not been processed
        // the next login would silently sign the user back in.
        const backOnApp = page.waitForRequest(
          (req) => req.isNavigationRequest() && req.url() === `${appOrigin}/`,
        );
        const nextLogin = page.waitForResponse((res) => {
          const url = new URL(res.url());
          return url.origin === appOrigin && url.pathname === '/auth/login';
        });
        await page.getByRole('button', { name: 'Sign out' }).click();
        await backOnApp;
        // A 303 to ZITADEL is a fresh login starting. A 429 would be the login rate limit.
        expect((await nextLogin).status(), 'Workspace login rate limit (CR-03) answered 429').toBe(
          303,
        );

        const cookies = await page.context().cookies(appOrigin);
        expect(cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '')).toBe(false);

        // The real proof: the redirect chain ends on a credential form. If the session survived
        // (here, or at ZITADEL, which would sign the user straight back in), the browser would
        // end up on the app instead.
        await expect(page).toHaveURL((url) => url.origin === authOrigin);
        // ZITADEL Login V2 remembers which accounts used this browser and may show an
        // "Accounts / Select the account you want to use" chooser. Listing the account is fine;
        // what matters is that picking it asks for the password again instead of signing
        // straight back in (which would mean ZITADEL's own session survived the logout).
        await expectZitadelCredentialForm(page, who);
        await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
      });
    });
  }
});

// The switcher only exists under `next dev` (NODE_ENV=development); the prod-like `app` profile
// returns 404 for it, which prod-no-switcher.spec.ts proves. Set BOS_E2E_NEXT_DEV=1 when the
// Workspace behind BASE_URL is `next dev`.
test.describe('dev persona switcher', () => {
  test.skip(
    process.env.BOS_E2E_NEXT_DEV !== '1',
    'needs the Workspace running under `next dev`; set BOS_E2E_NEXT_DEV=1',
  );

  test('lists active accounts with POST buttons and never shows a password', async ({ page }) => {
    await page.goto('/dev/personas');
    await expect(page.locator('[data-marker="BOS_DEV_PERSONA_SWITCHER"]')).toBeVisible();
    for (const who of personas) {
      const entry = page.getByRole('button', { name: who.label, exact: true });
      await expect(entry).toBeVisible();
      const form = entry.locator('..');
      await expect(form).toHaveAttribute('method', 'post');
      await expect(form).toHaveAttribute('action', '/dev/api/accounts');
    }
    const html = await page.content();
    for (const who of personas) expect(html).not.toContain(who.password);
  });

  test('a switcher button completes real login without credential entry', async ({
    page,
    baseURL,
  }) => {
    const sales = persona('sales');
    const hydrationErrors: string[] = [];
    page.on('console', (message) => {
      if (/hydration|hydrating/i.test(message.text())) hydrationErrors.push(message.text());
    });
    await page.goto('/dev/personas');
    await page.getByRole('button', { name: sales.label, exact: true }).click();
    await expect(page).toHaveURL(new URL('/', baseURL).toString());
    await expect(
      page.getByRole('heading', {
        name: /^(Welcome back|Good (morning|afternoon|evening)(, .+)?)$/,
      }),
    ).toBeVisible();
    const whoami = await page.evaluate(async () => {
      const response = await fetch('/dev/api/whoami');
      return { status: response.status, body: (await response.json()) as { roles: string[] } };
    });
    expect(whoami.status).toBe(200);
    expect(whoami.body.roles).toContain(sales.role);
    expect(hydrationErrors).toEqual([]);
  });
});

// Missing server state and an expired browser binding are what a delayed MFA callback sees.
// Replace only the first callback's state and expire its cookie; all authentication and the
// subsequent recovery use the real identity provider and workspace, with no mocked responses.
test('recovers from expired login state without visiting the error page', async ({
  page,
  context,
  baseURL,
}) => {
  const appOrigin = new URL(baseURL!).origin;
  const visited: string[] = [];
  page.on('request', (req) => {
    if (req.isNavigationRequest()) visited.push(new URL(req.url()).pathname);
  });
  let expired = false;
  await page.route(`${appOrigin}/auth/callback?**`, async (route) => {
    if (expired) return route.continue();
    expired = true;
    await context.clearCookies({ name: '__Host-bos_login' });
    const url = new URL(route.request().url());
    url.searchParams.set('state', 'expired-login-state-for-regression-test');
    await route.continue({ url: url.toString() });
  });
  await page.goto('/');
  await signInOnZitadel(page, persona('sales'), appOrigin);
  await expect(page).toHaveURL(`${appOrigin}/`);
  expect(expired).toBe(true);
  expect(visited).not.toContain('/auth/error');
  expect(visited.filter((p) => p === '/auth/login')).toHaveLength(2);
  const cookies = await context.cookies(appOrigin);
  expect(cookies.some((c) => c.name === SESSION_COOKIE)).toBe(true);
  expect(cookies.some((c) => c.name === '__Host-bos_login_recovery')).toBe(false);
});
