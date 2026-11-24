import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';
import { minimalPdf } from '../helpers/pdf-fixture';

/**
 * Warm-up step of the qa workflow ("qa fixtures": the specs skip it). .github/qa/demo-data.sql leaves a draft purchase
 * order PO-QA-1 with one line; this issues it as the procurement persona through the real screen, so its version 1,
 * its PDF job and the request's status come from the product. Safe to run again: an issued order is left alone.
 */
test('qa fixtures: issue the seeded purchase order', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const { context, page } = await signInAs(
    browser,
    baseURL ?? 'https://app.localhost',
    'procurement',
  );
  try {
    await page.goto('/procurement/orders');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const link = page.getByRole('link', { name: /PO-QA-1/ }).first();
    // No silent return: a stack without PO-QA-1 must fail here, not leave the later specs to fail without a reason.
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/procurement\/orders\/[0-9a-f-]{36}$/);
    const issue = page.getByRole('button', { name: 'Issue purchase order' });
    // The order streams its action buttons after the heading: give them a moment before deciding it is already issued.
    await page.waitForTimeout(3_000);
    if ((await issue.count()) > 0) {
      await issue.click();
      await page.getByRole('dialog').getByRole('button', { name: 'Issue purchase order' }).click();
      await expect(issue).toHaveCount(0, { timeout: 30_000 });
    }
    const body = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    // The proof: the page says the order is issued (the badge), whoever may go on to receive or bill it.
    expect(body, `PO-QA-1 page after issuing: ${body.slice(0, 600)}`).toMatch(/\bIssued\b/);
    await expect(page.getByRole('button', { name: 'Issue purchase order' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

/**
 * Portal specs read a stored login (storageState) of a customer and of an approved vendor. The dev personas
 * `customer` (Dev Customer Co) and `vendor` (Dev Vendor Co, VEND-DEV) sign in to the portal through the real login;
 * the cookies go to .dev/ (git-ignored and outside every uploaded artifact path).
 */
for (const key of ['customer', 'vendor'] as const) {
  test(`qa fixtures: portal sign-in state of ${key}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const portal = process.env.PORTAL_E2E_BASE_URL ?? 'https://portal.localhost';
    const { context, page } = await signInAs(browser, portal, key);
    try {
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL((url) => url.origin === new URL(portal).origin);
      await context.storageState({
        path: path.resolve(process.cwd(), `../../.dev/portal-${key}.json`),
      });
    } finally {
      await context.close();
    }
  });
}

/** The proof file the portal billing spec uploads: a one-page PDF with fictional text, in .dev/ with the sign-in states. */
test('qa fixtures: portal proof file', () => {
  const file = path.resolve(process.cwd(), '../../.dev/portal-proof.pdf');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, minimalPdf('QA fixture bank slip'));
});
