import { expect, test } from '@playwright/test';

import { persona } from './helpers/personas';
import { signInOnZitadel } from './helpers/zitadel-login';

// This journey deliberately needs next dev: a production-only run cannot prove the Dev pill
// mounts after hydration or displays the authenticated session. Production guards run separately.
test.use({ viewport: { width: 1280, height: 520 } });

test('P0 shell keeps its fixed edges and exposes real session facts without hydration issues', async ({
  page,
  baseURL,
}) => {
  expect(
    process.env.BOS_E2E_NEXT_DEV,
    'Run this spec against next dev with BOS_E2E_NEXT_DEV=1; production is covered separately',
  ).toBe('1');

  const appOrigin = new URL(baseURL ?? '').origin;
  const who = persona('founder');
  const hydrationProblems: string[] = [];
  const hydrationPattern =
    /hydrat|did not match|server rendered HTML|extra attributes from the server|Minified React error #(418|423|425)/i;
  page.on('console', (message) => {
    if (
      new URL(page.url()).origin === appOrigin &&
      ['warning', 'error'].includes(message.type()) &&
      hydrationPattern.test(message.text())
    ) {
      hydrationProblems.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    if (new URL(page.url()).origin === appOrigin && hydrationPattern.test(error.message)) {
      hydrationProblems.push(error.message);
    }
  });

  await page.goto('/');
  await signInOnZitadel(page, who, appOrigin);
  // The greeting uses the display name from /v1/me (`Good morning, Dev`); `Welcome back` when no name is known.
  const greeting = page.getByRole('heading', {
    name: /^(Welcome back|Good (morning|afternoon|evening)(, .+)?)$/,
  });
  await expect(greeting).toBeVisible();
  const devPill = page.getByRole('button', { name: 'Dev menu', exact: true });
  await expect(devPill).toBeVisible();

  // Exercise a fresh document too: the dev widget must not mutate the body during hydration.
  await page.reload();
  await expect(greeting).toBeVisible();
  await expect(devPill).toBeVisible();

  await test.step('only the nav scrolls at a 520px viewport height', async () => {
    const sidebar = page.locator('#app-sidebar');
    const nav = sidebar.getByRole('navigation', { name: 'Main', exact: true });
    const brand = sidebar.locator('[data-brand-name]');
    const footer = sidebar.locator(':scope > div').last();
    await expect(brand).toBeVisible();
    await expect(brand).toBeInViewport({ ratio: 1 });
    // The user card is the person's name with their roles under it (accountLabel: `Founder`, or `Sales, Finance`).
    const role = who.role.replace(/[_-]+/g, ' ');
    await expect(footer.getByText(new RegExp(`^(.+, )?${role}(, .+)?$`, 'i'))).toBeVisible();
    await expect(footer).toBeInViewport({ ratio: 1 });
    const before = { brand: await brand.boundingBox(), footer: await footer.boundingBox() };
    expect(before.brand).not.toBeNull();
    expect(before.footer).not.toBeNull();

    // Checking innerText covers every rendered row, including ones below the nav's scrollport.
    expect(await nav.innerText()).not.toMatch(/\bP\d+\b|\bLater\b|planned for phase/i);
    expect(await nav.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
    await nav.hover();
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => nav.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    await expect
      .poll(() =>
        nav.evaluate((node) => Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop)),
      )
      .toBeLessThanOrEqual(1);

    await expect(brand).toBeInViewport({ ratio: 1 });
    await expect(footer).toBeInViewport({ ratio: 1 });
    const after = { brand: await brand.boundingBox(), footer: await footer.boundingBox() };
    expect(after.brand?.y).toBe(before.brand?.y);
    expect(after.footer?.y).toBe(before.footer?.y);
    expect(await sidebar.evaluate((node) => node.scrollTop)).toBe(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  await test.step('menu search only returns destinations the user can open', async () => {
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    const search = page.getByRole('searchbox', { name: 'Search menu' });
    await search.fill('Department');
    await expect(nav.getByText('No matching pages')).toBeVisible();
    await search.fill('Settings');
    await expect(nav.getByRole('link')).toHaveCount(1);
    await expect(nav.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    await search.clear();
    await expect(nav.getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
  });

  await test.step('the Dev pill loads the actual authenticated whoami response', async () => {
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url() === `${appOrigin}/dev/api/whoami` && response.request().method() === 'GET',
    );
    await devPill.click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const facts = (await response.json()) as {
      userId: string;
      tenantId: string;
      organizationId: string;
      orgKind: string;
      roles: string[];
      correlationId: string;
    };
    expect(facts.orgKind).toBe('staff');
    expect(facts.roles).toContain(who.role);
    const panel = page.getByRole('region', { name: 'Dev tools', exact: true });
    await expect(devPill).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    const rows: [string, string][] = [
      ['User', facts.userId],
      ['Tenant', facts.tenantId],
      ['Organisation', facts.organizationId],
      ['Org kind', facts.orgKind],
      ['Roles', facts.roles.join(', ')],
      ['Correlation ID', facts.correlationId],
    ];
    for (const [label, value] of rows) {
      expect(value, `${label} must be present in the real session response`).toBeTruthy();
      const row = panel.locator('dl > div').filter({
        has: page.locator('dt').filter({ hasText: new RegExp(`^${label}$`) }),
      });
      await expect(row.locator('dd')).toHaveText(value);
    }
    await page.keyboard.press('Escape');
    await expect(devPill).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toBeHidden();
  });

  // Playwright's locators pierce Next's open shadow root. A Next tools launcher is normal;
  // an Issues indicator or error toast means the hydrated page reported a problem.
  const nextPortal = page.locator('nextjs-portal');
  await expect(nextPortal.getByText(/^[1-9]\d*\s+Issues?$/i).filter({ visible: true })).toHaveCount(
    0,
  );
  await expect(
    nextPortal.getByRole('button', { name: /\b[1-9]\d*\s+issues?\b/i }).filter({ visible: true }),
  ).toHaveCount(0);
  await expect(
    nextPortal.locator('[data-nextjs-toast-errors-parent]').filter({ visible: true }),
  ).toHaveCount(0);
  expect(hydrationProblems, 'Workspace hydration warnings and errors').toEqual([]);
});
