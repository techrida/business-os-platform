import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';
import {
  expectParam,
  expectSelected,
  multiSelectByLabel,
  toggleOptions,
} from '../helpers/multi-select';
import { minimalPdf } from '../helpers/pdf-fixture';

/**
 * The P4 payables screens (bill inbox, bills, bill detail, bill entry), against the real stack.
 * Not run by the unit that wrote it: it needs the payables API routes, the P4 permission grants,
 * and the seeded founder persona. Written for the lead to run; it skips unless BOS_E2E_P4=1.
 *
 * (1) The bills list loads, filters by status, and a status with no bills says so.
 * (2) The inbox loads and says whether anything is waiting.
 * (3) Bill entry without a submission offers vendor selection and an invoice upload.
 * (4) If a bill exists, its page shows the header, the lines and the match panel.
 *
 * Set BOS_E2E_BILL_ID to the id of an existing bill to run (4).
 */

test.skip(process.env.BOS_E2E_P4 !== '1', 'set BOS_E2E_P4=1 to run the P4 payables screens');

test('the bills list loads and filters', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto('/payables/bills');
    await expect(founder.page.getByRole('heading', { level: 1, name: 'Bills' })).toBeVisible();
    // Filters apply as they change: no Show button, the URL is the state.
    const status = multiSelectByLabel(founder.page, 'Status');
    await toggleOptions(status, ['voided']);
    await expectParam(founder.page, 'status', ['voided']);
    await expectSelected(status, ['voided']);
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('the inbox loads and bill entry works without a submission', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto('/payables/inbox');
    await expect(founder.page.getByRole('heading', { level: 1, name: 'Bill inbox' })).toBeVisible();
    await founder.page.goto('/payables/bills/new');
    await expect(founder.page.getByRole('heading', { level: 1, name: 'New bill' })).toBeVisible();
    // One live-search vendor box (a combobox posting vendorPartyId), then the invoice details.
    await expect(founder.page.locator('input[type="hidden"][name="vendorPartyId"]')).toBeAttached();
    await expect(founder.page.getByRole('combobox').first()).toBeVisible();
    await expect(founder.page.locator('input[name="vendorInvoiceNo"]')).toBeVisible();
    // No vendor and no file yet: the invoice cannot be uploaded.
    await expect(
      founder.page.getByRole('button', { name: 'Upload invoice', exact: true }),
    ).toBeDisabled();
    // A file alone is not enough: with no vendor chosen the upload stays off.
    await founder.page.locator('input[type="file"]').setInputFiles({
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: minimalPdf('Bill entry'),
    });
    await expect(
      founder.page.getByRole('button', { name: 'Upload invoice', exact: true }),
    ).toBeDisabled();
    // A search that matches no vendor says so, and the upload stays off.
    const vendorBox = founder.page.getByRole('combobox').first();
    // A long vendor list is searched on the server: the message must come from that answer, not from the box's
    // first filtering of the page's own short list. A short list never asks, so the wait ends without an answer.
    const answered = founder.page
      .waitForResponse((res) => res.url().includes('/payables/vendor-search'), { timeout: 5_000 })
      .catch(() => null);
    await vendorBox.fill('zzzz-no-such-vendor');
    await answered;
    await expect(founder.page.getByRole('option')).toHaveCount(0);
    await expect(
      // The list's message; the same words also sit in a screen-reader status region.
      founder.page.locator('p', {
        hasText: 'No vendor matches. Ask Procurement to add the vendor.',
      }),
    ).toBeVisible();
    await expect(
      founder.page.getByRole('button', { name: 'Upload invoice', exact: true }),
    ).toBeDisabled();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('a bill shows its lines and the match panel', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const id = process.env.BOS_E2E_BILL_ID;
  test.skip(id === undefined || id === '', 'set BOS_E2E_BILL_ID to an existing bill');
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto(`/payables/bills/${id ?? ''}`);
    await expect(founder.page.getByRole('heading', { name: 'Lines' })).toBeVisible();
    await expect(founder.page.getByRole('heading', { name: 'Totals' })).toBeVisible();
    await expect(founder.page.getByRole('heading', { name: /^Match/ })).toBeVisible();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
