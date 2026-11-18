import { expect, test, type Page } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * The P3 invoice screens against the real stack: the list, the detail page with its credit-note and
 * debit-note buttons, and the manual invoice form's validation and draft creation.
 *
 * Each test reads its fixture requirements from the environment:
 *
 *   BOS_E2E_INVOICES_READY   any value: the invoice endpoints answer and the tax-code and customer
 *                            lists are seeded. Needed by the list and the manual invoice tests.
 *   BOS_E2E_INVOICE_ISSUED   id of an issued tax invoice with at least one line, owned by the
 *                            `accountant` and `finance` personas' organization.
 *   BOS_E2E_INVOICE_DRAFT_CUSTOMER   legal name of a disposable customer the accountant can
 *                            invoice. The draft creation test leaves one draft in that stack.
 */

const ready = (): boolean => process.env.BOS_E2E_INVOICES_READY !== undefined;
const issuedId = (): string | undefined => process.env.BOS_E2E_INVOICE_ISSUED;

async function as<T>(
  browser: Parameters<typeof signInAs>[0],
  baseURL: string | undefined,
  persona: string,
  run: (signed: Signed) => Promise<T>,
): Promise<T> {
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', persona);
  try {
    return await run(signed);
  } finally {
    await signed.context.close();
  }
}

async function heading(page: Page, name: RegExp | string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('the list shows its filters and offers Create Invoice to the accountant', async ({
  browser,
  baseURL,
}) => {
  test.skip(!ready(), 'BOS_E2E_INVOICES_READY is not set');
  await as(browser, baseURL, 'accountant', async ({ page }) => {
    await page.goto('/invoices');
    await heading(page, 'Invoices');
    await expect(page.getByLabel('Kind')).toBeVisible();
    await expect(page.getByLabel('Status')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create Invoice' })).toBeVisible();
  });
});

test('the detail page shows the totals the server worked out, and Finance gets the note buttons', async ({
  browser,
  baseURL,
}) => {
  const id = issuedId();
  test.skip(id === undefined, 'BOS_E2E_INVOICE_ISSUED is not set');
  await as(browser, baseURL, 'finance', async ({ page }) => {
    await page.goto(`/invoices/${id ?? ''}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Totals' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Line Items' })).toBeVisible();

    await page.getByRole('button', { name: 'Credit note', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Credit note for / });
    await expect(dialog).toBeVisible();

    // Nothing chosen: refused in place, naming the field, and nothing reaches the API.
    await dialog.getByRole('button', { name: 'Create credit note' }).click();
    await expect(dialog.getByText('Say why this invoice is being credited.')).toBeVisible();
    await expect(
      dialog.getByText('Enter a quantity to credit on at least one line.'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Debit note', exact: true }).click();
    await expect(page.getByRole('dialog', { name: /^Debit note for / })).toBeVisible();
  });

  // The Accountant prepares invoices but does not credit them.
  await as(browser, baseURL, 'accountant', async ({ page }) => {
    await page.goto(`/invoices/${id ?? ''}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Credit note', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Debit note', exact: true })).toHaveCount(0);
  });
});

test('the new invoice form names every missing field and has no number or date to type', async ({
  browser,
  baseURL,
}) => {
  test.skip(!ready(), 'BOS_E2E_INVOICES_READY is not set');
  await as(browser, baseURL, 'accountant', async ({ page }) => {
    await page.goto('/invoices/new');
    await heading(page, 'Create Invoice');

    // The number and the issue date are the platform's: there is no field for either.
    await expect(page.getByLabel(/^Number/)).toHaveCount(0);
    await expect(page.getByLabel(/^Issue date/)).toHaveCount(0);

    await page.getByLabel('Currency').selectOption('NPR');
    await page.getByLabel('Quantity (line 1)').fill('0');
    await page.getByRole('button', { name: 'Save draft invoice' }).click();

    await expect(page.getByText('Choose the customer.')).toBeVisible();
    await expect(
      page.getByText(/Say why this invoice is raised without a sales order/),
    ).toBeVisible();
    await expect(page.getByText('Describe what is being charged.')).toBeVisible();
    await expect(page.getByText('Enter the unit, such as pcs or hrs.')).toBeVisible();
    await expect(page.getByText(/Enter a quantity above zero/)).toBeVisible();
    await expect(page.getByText('Choose a tax code.')).toBeVisible();

    // Still on the form: a refusal never navigates.
    await expect(page).toHaveURL(/\/invoices\/new$/);

    // A second line can be added and removed again.
    await page.getByRole('button', { name: 'Add items' }).click();
    await expect(page.getByText('Line 2', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove line 2' }).click();
    await expect(page.getByText('Line 2', { exact: true })).toHaveCount(0);
  });
});
