import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

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
