import { expect, test } from '@playwright/test';

/**
 * Customer invoices and payments, end to end. Needs a running portal and API with P3 seed data, and
 * a signed-in customer's storage state. The lead runs it; it skips itself when the inputs are
 * missing (same convention as ../quotations.spec.ts).
 *
 *   PORTAL_E2E_BASE_URL         e.g. http://localhost:3002
 *   PORTAL_E2E_STORAGE_STATE    path to a storage state of a signed-in customer user
 *   PORTAL_E2E_INVOICE_ID       an issued, unpaid invoice of that customer
 *   PORTAL_E2E_DRAFT_ID         a draft invoice of that customer (must show as not found)
 *   PORTAL_E2E_FOREIGN_INVOICE_ID       an issued invoice of another customer
 *   PORTAL_E2E_PROOF_FILE       path to a small PDF or PNG to upload as proof
 */
const base = process.env.PORTAL_E2E_BASE_URL;
const storageState = process.env.PORTAL_E2E_STORAGE_STATE;
const invoiceId = process.env.PORTAL_E2E_INVOICE_ID;
const draftId = process.env.PORTAL_E2E_DRAFT_ID;
const foreignId = process.env.PORTAL_E2E_FOREIGN_INVOICE_ID;
const proofFile = process.env.PORTAL_E2E_PROOF_FILE;

test.skip(!base || !storageState, 'PORTAL_E2E_BASE_URL and PORTAL_E2E_STORAGE_STATE are not set');
if (storageState) test.use({ storageState, baseURL: base });

const FORBIDDEN = /\b(cost|margin|markup)\b/i;

test('lists the issued invoices with their open amount, never a draft', async ({ page }) => {
  await page.goto('/invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'Your invoices' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Your invoices' });
  const empty = page.getByRole('heading', { name: 'No invoices yet' });
  await expect(table.or(empty)).toBeVisible();
  if (await table.isVisible()) {
    for (const name of ['Invoice', 'Due', 'Total', 'Open amount']) {
      await expect(table.getByRole('columnheader', { name })).toBeVisible();
    }
    if (draftId) await expect(page.locator(`a[href="/invoices/${draftId}"]`)).toHaveCount(0);
  }
});

test('a draft, a foreign and a junk invoice id all show the same "Invoice not found"', async ({
  page,
}) => {
  test.skip(
    !draftId || !foreignId,
    'PORTAL_E2E_DRAFT_ID and PORTAL_E2E_FOREIGN_INVOICE_ID are not set',
  );
  const bodies: string[] = [];
  for (const id of [draftId, foreignId, 'not-an-id', '00000000-0000-4000-8000-000000000000']) {
    await page.goto(`/invoices/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice not found' })).toBeVisible();
    bodies.push(await page.locator('main').innerText());
  }
  expect(new Set(bodies).size).toBe(1);
  for (const id of [draftId, foreignId]) {
    const pdf = await page.request.get(`/invoices/${id}/document`);
    expect(pdf.status()).toBe(404);
    expect(await pdf.text()).toBe('Invoice not found.');
  }
});

test('the invoice page shows lines, VAT, totals, due date and status, and no internal word', async ({
  page,
}) => {
  test.skip(!invoiceId, 'PORTAL_E2E_INVOICE_ID is not set');
  await page.goto(`/invoices/${invoiceId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('INV');
  await expect(page.getByRole('table', { name: /^Items/ })).toBeVisible();
  await expect(page.getByText('Taxable amount')).toBeVisible();
  await expect(page.getByText('Due date', { exact: true })).toBeVisible();
  await expect(page.getByText(/^(Unpaid|Partly paid|Overdue)$/)).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(FORBIDDEN);
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute(
    'href',
    `/invoices/${invoiceId}/document`,
  );
});

test('submitting a payment needs proof, then lands in the list as awaiting verification', async ({
  page,
}) => {
  test.skip(!invoiceId || !proofFile, 'PORTAL_E2E_INVOICE_ID and PORTAL_E2E_PROOF_FILE not set');
  await page.goto(`/invoices/${invoiceId}`);
  await page.getByRole('link', { name: 'Submit a payment' }).click();
  await expect(page).toHaveURL(/\/payments\/new\?invoice=/);
  await expect(page.getByLabel('Amount paid')).not.toHaveValue('');

  // No proof yet: the server refuses and says which field.
  await page.getByLabel('Bank reference').fill('E2E-REF-1');
  await page.getByRole('button', { name: 'Submit payment' }).click();
  await expect(page.getByText('Add a bank slip or receipt')).toBeVisible();

  await page.getByLabel('Proof of payment').setInputFiles(proofFile!);
  await expect(page.getByRole('list', { name: 'Uploaded proof' })).toBeVisible();
  await page.getByRole('button', { name: 'Submit payment' }).click();
  await expect(page).toHaveURL(/\/payments\?submitted=1/);
  await expect(page.getByRole('status').filter({ hasText: 'We have your payment' })).toBeVisible();
  await expect(page.getByText('Awaiting verification').first()).toBeVisible();
});

test('a payment from a foreign or draft invoice id shows the invoice not-found page', async ({
  page,
}) => {
  test.skip(
    !draftId || !foreignId,
    'PORTAL_E2E_DRAFT_ID and PORTAL_E2E_FOREIGN_INVOICE_ID are not set',
  );
  for (const id of [draftId, foreignId, 'not-an-id', '00000000-0000-4000-8000-000000000000']) {
    await page.goto(`/payments/new?invoice=${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Invoice not found' })).toBeVisible();
  }
});
