import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * The P4 goods and service receipt screens, against the real stack. Not run by the unit that wrote
 * it: it needs the receipt and purchase order API routes, the P4 permission grants, and the seeded
 * founder persona. Written for the lead to run; it skips unless BOS_E2E_P4=1. The founder holds
 * every permission, so both kinds can be tried with one person. No seeded persona holds only the
 * warehouse role, so the warehouse-only view is not covered here.
 *
 * (1) Without a purchase order the receipts screen asks for one, and an ID that is not one is said
 *     to be wrong.
 * (2) Set BOS_E2E_PO_ID to an issued or partly received purchase order: its receipts open from
 *     `?po=`, show where the order stands, and the new-receipt form refuses an empty receipt in
 *     words. It creates nothing.
 */

test.skip(process.env.BOS_E2E_P4 !== '1', 'set BOS_E2E_P4=1 to run the P4 receipt screens');

test('the receipts screen asks for a purchase order', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto('/procurement/receipts');
    await expect(founder.page.getByRole('heading', { level: 1, name: 'Receipts' })).toBeVisible();
    await founder.page.getByLabel('Purchase order ID').fill('not-an-id');
    await founder.page.getByRole('button', { name: 'Open receipts' }).click();
    await expect(founder.page).toHaveURL(/po=not-an-id/);
    await expect(founder.page.getByText('That is not a purchase order ID')).toBeVisible();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('the receipts of an order open, and an empty receipt is refused in words', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const id = process.env.BOS_E2E_PO_ID;
  test.skip(id === undefined || id === '', 'set BOS_E2E_PO_ID to an issued purchase order');
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto(`/procurement/receipts?po=${id ?? ''}`);
    await expect(
      founder.page.getByRole('heading', { name: 'Where the order stands' }),
    ).toBeVisible();

    await founder.page.goto(`/procurement/receipts/new?po=${id ?? ''}`);
    await expect(
      founder.page.getByRole('heading', { level: 1, name: 'New receipt' }),
    ).toBeVisible();
    await expect(founder.page.getByLabel('Received on')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await founder.page.getByRole('button', { name: 'Save draft receipt' }).click();
    await expect(founder.page.getByText('Enter a quantity on at least one line.')).toBeVisible();
    await expect(founder.page).toHaveURL(/\/procurement\/receipts\/new/);
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
