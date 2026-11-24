import { expect, test, type Page } from '@playwright/test';

import { approveInboxRequest, idFromUrl, pickFromCombobox } from '../helpers/fixture-flow';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { minimalPdf } from '../helpers/pdf-fixture';
import { chooseOption, selectByLabel, selectByName } from '../helpers/select';

/**
 * Warm-up step of the qa workflow ("qa fixtures": the specs skip it). The invoice and payment specs, and the
 * portal's billing specs, need an issued invoice, a draft one, an invoice of another customer and a verified payment.
 * Each is made by the persona who would make it, through the same screens, in the order the business rules force:
 * Finance drafts and submits (the drafter cannot approve), the Accountant approves step one, the second Finance user
 * approves step two, Finance issues; the Accountant records a payment, Finance verifies it. export-ids.sh finds each
 * document by the marker text in its reason or bank reference. A fresh stack only: it makes new documents each run.
 */
// An action that finds nothing fails in half a minute, not at the end of the test.
test.use({ actionTimeout: 30_000 });

const CUSTOMER = 'Dev Customer Co';
const OTHER_CUSTOMER = 'Acme Robotics Inc';
const ISSUED_REASON = 'QA fixture: issued invoice';
const OTHER_REASON = 'QA fixture: invoice of another customer';
const DRAFT_REASON = 'QA fixture: draft invoice';
const PAYMENT_REFERENCE = 'QA-FIXTURE-PAYMENT';

async function draftInvoice(page: Page, customer: string, reason: string): Promise<string> {
  await page.goto('/invoices/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Create Invoice' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await pickFromCombobox(
    page,
    'Organization legal name',
    customer.split(' ')[0] ?? customer,
    customer,
  );
  await chooseOption(selectByName(page, 'currency'), 'NPR');
  await page.getByLabel('Why is there no sales order?').fill(reason);
  await page.getByLabel('Description (line 1)').fill('QA fixture training');
  await page.getByLabel('Unit (line 1)').fill('hr');
  await page.getByLabel('Quantity (line 1)').fill('2');
  await page.getByLabel('Unit price (NPR) (line 1)').fill('125.00');
  await chooseOption(selectByLabel(page, 'Tax code (line 1)'), { index: 1 });
  await page.getByRole('button', { name: 'Save draft invoice' }).click();
  await expect(page).toHaveURL(/\/invoices\/[a-f0-9-]{36}$/);
  return idFromUrl(page);
}

async function submitInvoice(page: Page, id: string): Promise<void> {
  await page.goto(`/invoices/${id}`);
  await page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Submit / });
  await dialog.getByRole('button', { name: 'Submit for approval', exact: true }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText('Awaiting approval', { exact: true }).first()).toBeVisible();
}

async function issueInvoice(page: Page, id: string): Promise<void> {
  await page.goto(`/invoices/${id}`);
  const issue = page.getByRole('button', { name: /^Issue tax invoice$/i });
  // Approving moves the invoice to Approved in the worker-free decision hook; give a slow read a few reloads.
  await expect(async () => {
    await page.reload();
    await expect(issue).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await issue.click();
  const dialog = page.getByRole('dialog', { name: /^Issue / });
  await dialog.getByRole('button', { name: /^Issue tax invoice$/i }).click();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByText(/^INV-/).first()).toBeVisible({ timeout: 30_000 });
}

async function recordPayment(page: Page): Promise<string> {
  await page.goto('/payments/new');
  await pickFromCombobox(page, 'Customer', 'Dev Customer', CUSTOMER);
  await page.getByLabel('Amount received').fill('5000.00');
  await page.getByLabel('Bank reference').fill(PAYMENT_REFERENCE);
  await page.getByLabel('Add proof files').setInputFiles({
    name: 'qa-fixture-slip.pdf',
    mimeType: 'application/pdf',
    buffer: minimalPdf('QA fixture slip'),
  });
  await expect(
    page.getByRole('list', { name: 'Uploaded proof' }).getByText('qa-fixture-slip.pdf'),
  ).toBeVisible({ timeout: 60_000 });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.getByRole('button', { name: 'Record payment', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    const opened = await page
      .waitForURL(/\/payments\/[0-9a-f-]{36}$/, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) break;
    await expect(page.getByText(/A proof file is not ready yet/)).toBeVisible();
    await page.waitForTimeout(5_000);
  }
  await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
  return idFromUrl(page);
}

test('qa fixtures: issued, draft and other-customer invoices and a verified payment', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(900_000);
  const base = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  const as = async (key: string): Promise<Page> => {
    const signed = await signInAs(browser, base, key);
    opened.push(signed);
    return signed.page;
  };
  try {
    const ids = { issued: '', other: '', payment: '' };
    await test.step('Finance drafts the three invoices and submits two', async () => {
      const finance = await as('finance');
      ids.issued = await draftInvoice(finance, CUSTOMER, ISSUED_REASON);
      await submitInvoice(finance, ids.issued);
      ids.other = await draftInvoice(finance, OTHER_CUSTOMER, OTHER_REASON);
      await submitInvoice(finance, ids.other);
      await draftInvoice(finance, CUSTOMER, DRAFT_REASON);
    });
    await test.step('the Accountant approves step one and records the payment', async () => {
      const accountant = await as('accountant');
      await approveInboxRequest(
        accountant,
        /Tax invoice for Dev Customer Co/,
        'QA fixture: checked',
      );
      await approveInboxRequest(accountant, /Tax invoice for Acme Robotics/, 'QA fixture: checked');
      ids.payment = await recordPayment(accountant);
    });
    await test.step('the second Finance user approves step two', async () => {
      const finance2 = await as('finance2');
      await approveInboxRequest(
        finance2,
        /Tax invoice for Dev Customer Co/,
        'QA fixture: approved',
      );
      await approveInboxRequest(finance2, /Tax invoice for Acme Robotics/, 'QA fixture: approved');
    });
    await test.step('Finance issues both invoices and verifies the payment', async () => {
      const finance = await as('finance');
      await issueInvoice(finance, ids.issued);
      await issueInvoice(finance, ids.other);
      await finance.goto(`/payments/${ids.payment}`);
      await finance.getByRole('button', { name: 'Verify payment', exact: true }).click();
      const dialog = finance.getByRole('dialog', { name: 'Verify this payment', exact: true });
      await dialog.getByRole('button', { name: 'Verify payment', exact: true }).click();
      const done = dialog.getByRole('button', { name: 'Done', exact: true });
      if (await done.isVisible({ timeout: 10_000 }).catch(() => false)) await done.click();
      // The page shows the receipt number once the payment is verified.
      await expect(async () => {
        await finance.goto(`/payments/${ids.payment}`);
        await expect(finance.getByRole('heading', { level: 1 })).toContainText('RCPT-', {
          timeout: 3_000,
        });
      }).toPass({ timeout: 60_000 });
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
