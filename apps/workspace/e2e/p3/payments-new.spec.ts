import { expect, type Page, test } from '@playwright/test';

import { timeAction } from '../helpers/flow-timing';
import { pickFromCombobox } from '../helpers/fixture-flow';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { minimalPdf } from '../helpers/pdf-fixture';

/**
 * The staff Record payment form, against the real stack. Not run by the unit that wrote it: it needs
 * the `/v1/payments` and `/v1/payment-proofs` routes (U7, U13), the payment grants, the virus scanner
 * (ClamAV) and one customer the staff can read.
 *
 * Skips unless `BOS_E2E_PAYMENT_CUSTOMER` is set to the exact legal name of a customer, as the
 * picker shows it (for example "Himalayan Traders Pvt. Ltd.").
 *
 * (1) `accountant` holds `payment.record` and sees the Record payment link on the list; `management`
 *     reads payments but does not, and the page itself says so in words.
 * (2) An empty form is refused in place with each wrong field named, and nothing is sent. Tax
 *     withheld without its code is refused too.
 * (3) A full record: pick the customer, add a PDF proof (the customer locks while proof is held),
 *     submit. A scan still running answers "A proof file is not ready yet"; the test presses the
 *     button again until the payment opens, which also shows the same key never records twice.
 */

const CUSTOMER = process.env['BOS_E2E_PAYMENT_CUSTOMER'];

test.skip(CUSTOMER === undefined, 'BOS_E2E_PAYMENT_CUSTOMER is not set');

/** Chooses the customer whose option text starts with the name in the env var. */
async function pickCustomer(page: Page): Promise<void> {
  // Fails here, naming the option, when the customer is not in the picker.
  await pickFromCombobox(page, 'Customer', (CUSTOMER ?? '').split(' ')[0] ?? '', CUSTOMER ?? '');
}

async function open(browser: Parameters<typeof signInAs>[0], base: string, persona: string) {
  const who = await signInAs(browser, base, persona);
  await who.page.goto('/payments/new');
  return who;
}

test('the Record payment link and page follow the payment.record grant', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const accountant = await signInAs(browser, appBase, 'accountant');
    opened.push(accountant);
    await accountant.page.goto('/payments');
    const link = accountant.page.getByRole('link', { name: 'Record payment' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(
      accountant.page.getByRole('heading', { level: 1, name: 'Record payment' }),
    ).toBeVisible();

    const reader = await signInAs(browser, appBase, 'management');
    opened.push(reader);
    await reader.page.goto('/payments');
    await expect(reader.page.getByRole('heading', { level: 1, name: 'Payments' })).toBeVisible();
    await expect(reader.page.getByRole('link', { name: 'Record payment' })).toHaveCount(0);
    await reader.page.goto('/payments/new');
    await expect(
      reader.page.getByText('Your roles do not include recording payments'),
    ).toBeVisible();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('an empty form names every wrong field, and tax needs its code', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const accountant = await open(browser, baseURL ?? 'https://app.localhost', 'accountant');

  try {
    const page = accountant.page;
    await page.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText('Choose the customer who paid.')).toBeVisible();
    await expect(page.getByText(/Enter the amount received/)).toBeVisible();
    await expect(page.getByText(/Add a bank slip or receipt/)).toBeVisible();
    await expect(page.getByLabel('Customer', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await pickCustomer(page);
    await page.getByLabel('Amount received').fill('1000.00');
    await page.getByText('The customer withheld tax at source (TDS)').click();
    await page.getByLabel('Tax withheld', { exact: true }).fill('15.00');
    await page.getByRole('button', { name: 'Record payment' }).click();
    // The form is complete as far as the browser can tell, so the review opens first.
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText(/Name the withholding code when tax was withheld/)).toBeVisible();
    // What was typed is still there after the refusal.
    await expect(page.getByLabel('Amount received')).toHaveValue('1,000.00');
  } finally {
    await accountant.context.close();
  }
});

test('records a payment with a PDF proof and opens it', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const accountant = await open(browser, baseURL ?? 'https://app.localhost', 'accountant');

  try {
    const page = accountant.page;
    await pickCustomer(page);
    await page.getByLabel('Amount received').fill('1000.00');
    await page.getByLabel('Bank reference').fill(`E2E-${Date.now()}`);

    await page.getByLabel('Add proof files').setInputFiles({
      name: 'bank-slip.pdf',
      mimeType: 'application/pdf',
      buffer: minimalPdf('Bank slip e2e'),
    });
    const uploaded = page.getByRole('list', { name: 'Uploaded proof' });
    await expect(uploaded.getByText('bank-slip.pdf')).toBeVisible({ timeout: 60_000 });
    // A proof belongs to the customer it was uploaded for, so the customer is locked now.
    await expect(page.getByLabel('Customer', { exact: true })).toBeDisabled();

    // The scan may still be running: the form says to wait, and pressing again is safe.
    const submit = page.getByRole('button', { name: 'Record payment' });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await submit.click();
      const confirm = page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm', exact: true });
      const opened = await timeAction('record-payment', confirm, async () => {
        const success = await page
          .waitForURL(/\/payments\/[0-9a-f-]{36}$/, { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        if (success) {
          await expect(page.getByText('Awaiting verification', { exact: true })).toBeVisible();
          return true;
        }
        return false;
      });
      if (opened) break;
      await expect(page.getByText(/A proof file is not ready yet/)).toBeVisible();
      await page.waitForTimeout(5_000);
    }
    await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Left to allocate')).toBeVisible();
  } finally {
    await accountant.context.close();
  }
});
