import { expect, test } from '@playwright/test';

import { loadPersonas, persona } from './helpers/personas';
import { expectZitadelCredentialForm, signInOnZitadel } from './helpers/zitadel-login';

/**
 * Each seeded persona signs in through the real ZITADEL Login V2 form and the Workspace's real
 * OIDC code flow. Nothing is stubbed: no token, header or cookie is faked anywhere.
 */

const SESSION_COOKIE = '__Host-bos_session';
const authOrigin = process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost';

// Read at collection time, so a missing `.dev/personas.json` fails loudly with "run pnpm seed".
const personas = loadPersonas();

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
          await expect(page.getByRole('heading', { name: 'P0: platform ready' })).toBeVisible();
          // The header shows the org kind badge and the roles that came from the token.
          const header = page.getByRole('banner');
          await expect(header).toContainText('staff');
          await expect(header).toContainText(who.role);
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
        await page.getByRole('button', { name: 'Sign out' }).click();
        // Back on the app or still on ZITADEL's logout page: either way the cookie must be gone.
        await expect
          .poll(async () => {
            const cookies = await page.context().cookies(appOrigin);
            return cookies.some((c) => c.name === SESSION_COOKIE && c.value !== '');
          })
          .toBe(false);

        // The real proof: asking for `/` again must reach a credential form. If the session
        // survived (here, or at ZITADEL, which would sign the user straight back in), the
        // browser would end up on the app instead.
        await page.goto('/');
        await expect(page).toHaveURL((url) => url.origin === authOrigin);
        // ZITADEL Login V2 remembers which accounts used this browser and may show an
        // "Accounts / Select the account you want to use" chooser. Listing the account is fine;
        // what matters is that picking it asks for the password again instead of signing
        // straight back in (which would mean ZITADEL's own session survived the logout).
        const chooser = page.getByRole('heading', { name: 'Accounts', level: 1 });
        // Wait until ZITADEL has rendered either page before deciding (avoids a race).
        await expect(chooser.or(page.getByLabel(/^\s*(login ?name|password)\s*$/i))).toBeVisible({
          timeout: 30_000,
        });
        if (await chooser.isVisible()) {
          const name = who.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          await page.getByRole('button', { name: new RegExp(name, 'i') }).click();
        }
        await expectZitadelCredentialForm(page);
        await expect(page.getByRole('heading', { name: 'P0: platform ready' })).toHaveCount(0);
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

  test('lists the personas with a login link each and never shows a password', async ({ page }) => {
    await page.goto('/dev/personas');
    await expect(page.locator('[data-marker="BOS_DEV_PERSONA_SWITCHER"]')).toBeVisible();

    for (const who of personas) {
      const link = page.getByRole('link', { name: who.label, exact: true });
      await expect(link).toBeVisible();
      const href = new URL((await link.getAttribute('href')) ?? '', 'https://x.invalid');
      expect(href.pathname).toBe('/auth/login');
      expect(href.searchParams.get('login_hint')).toBe(who.preferredLoginName);
      expect(href.searchParams.get('prompt')).toBe('login');
    }

    const html = await page.content();
    for (const who of personas) expect(html).not.toContain(who.password);
  });

  test('a switcher link starts a real login that works', async ({ page, baseURL }) => {
    const sales = persona('sales');
    await page.goto('/dev/personas');
    await page.getByRole('link', { name: sales.label, exact: true }).click();
    // login_hint makes ZITADEL open the password page directly.
    await signInOnZitadel(page, sales, new URL(baseURL ?? '').origin);
    await expect(page.getByRole('heading', { name: 'P0: platform ready' })).toBeVisible();
  });
});
