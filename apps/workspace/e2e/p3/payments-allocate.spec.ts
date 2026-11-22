import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * The allocate panel and deallocate dialog on the payment detail, against the real stack. Not run by
 * the unit that wrote it: it needs the `/v1/payments` and `/v1/receivables` routes (U7, U8), the
 * payment grants, and at least one verified payment with an open invoice of the same customer and
 * currency. Written for the lead to run once those exist. `founder` holds every grant, so it sees
 * the panel; `accountant` and `finance` hold `payment.allocate` too, and `management` does not.
 *
 * (1) On a verified payment the panel lists open invoices by number, and an amount that is not a
 *     positive number with up to 2 decimals is refused in place, naming the invoice.
 * (2) An amount larger than the invoice has open is refused by the server in words, and the form
 *     keeps what was typed. Uses an explicit disposable fixture pair.
 * (3) Allocating then deallocating with a reason adds a reversal row. Uses that same explicit pair.
 */

async function openFirstVerifiedPayment(finance: Signed): Promise<boolean> {
  const configured = process.env['BOS_E2E_PAYMENT_VERIFIED'];
  if (configured) {
    await finance.page.goto('/payments/' + configured);
    await expect(finance.page.getByRole('heading', { level: 1, name: /RCPT-/ })).toBeVisible();
    return true;
  }
  await finance.page.goto('/payments?status=verified');
  const first = finance.page.getByRole('link', { name: /RCPT-/ }).first();
  if ((await first.count()) === 0) return false;
  await first.click();
  await expect(finance.page.getByRole('heading', { level: 1, name: /RCPT-/ })).toBeVisible();
  return true;
}

test('a verified payment offers the allocate panel and refuses a bad amount in place', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);

    const found = await openFirstVerifiedPayment(finance);
    test.skip(!found, 'needs a seeded verified payment');

    const panel = finance.page.getByRole('region', { name: 'Allocate this payment', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Left on this payment')).toBeVisible();
    await expect(panel.getByText(/Customer advance in [A-Z]{3}/)).toBeVisible();

    const amounts = panel.getByRole('textbox', { name: /^Amount to allocate to / });
    test.skip((await amounts.count()) === 0, 'needs an open invoice for this customer');

    await test.step('a third decimal is not accepted in the box', async () => {
      await amounts.first().fill('');
      await amounts.first().pressSequentially('12.345');
      await expect(amounts.first()).toHaveValue('12.34');
    });

    await test.step('nothing typed asks for at least one amount', async () => {
      await amounts.first().fill('');
      await panel.getByRole('button', { name: 'Allocate payment' }).click();
      await expect(panel.getByRole('alert')).toContainText('at least one invoice');
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('the form stops more than an invoice has open, in words', async ({ browser, baseURL }) => {
  test.skip(
    !process.env['BOS_E2E_PAYMENT_VERIFIED'] || !process.env['BOS_E2E_INVOICE_ISSUED'],
    'needs an explicit disposable verified payment and open invoice pair',
  );
  test.setTimeout(120_000);
  const finance = await signInAs(browser, baseURL ?? 'https://app.localhost', 'finance');
  try {
    await openFirstVerifiedPayment(finance);
    const panel = finance.page.getByRole('region', { name: 'Allocate this payment', exact: true });
    // The named input is hidden; the visible box is the text input just before it.
    const amount = panel.locator(
      'xpath=//input[@name="amount:' +
        process.env['BOS_E2E_INVOICE_ISSUED'] +
        '"]/preceding::input[@type="text" or not(@type)][1]',
    );
    const allocations = finance.page.getByRole('region', { name: 'Allocations', exact: true });
    const before = await allocations.innerText();
    await amount.fill('999999.00');
    // The form now catches this before the server: the row says why and Allocate is off.
    await expect(panel).toContainText('More than the');
    await expect(
      panel.getByRole('button', { name: 'Allocate payment', exact: true }),
    ).toBeDisabled();
    await expect(amount).toHaveValue(/^9,?99,?999\.00$/);
    await expect(allocations).toHaveText(before, { useInnerText: true });
  } finally {
    await finance.context.close();
  }
});

test('allocating then deallocating with a reason adds a reversal row', async ({
  browser,
  baseURL,
}) => {
  test.skip(
    !process.env['BOS_E2E_PAYMENT_VERIFIED'] || !process.env['BOS_E2E_INVOICE_ISSUED'],
    'needs an explicit disposable verified payment and open invoice pair',
  );
  test.setTimeout(120_000);
  const finance = await signInAs(browser, baseURL ?? 'https://app.localhost', 'finance');
  try {
    await openFirstVerifiedPayment(finance);
    const panel = finance.page.getByRole('region', { name: 'Allocate this payment', exact: true });
    // The named input is hidden; the visible box is the text input just before it.
    const amount = panel.locator(
      'xpath=//input[@name="amount:' +
        process.env['BOS_E2E_INVOICE_ISSUED'] +
        '"]/preceding::input[@type="text" or not(@type)][1]',
    );
    const invoice = await amount.getAttribute('aria-label');
    const number = invoice?.replace('Amount to allocate to ', '') ?? '';
    expect(number).toMatch(/^INV-/);
    const allocations = finance.page.getByRole('region', { name: 'Allocations', exact: true });
    const before = await allocations.getByRole('row').count();
    await amount.fill('1.00');
    await panel.getByRole('button', { name: 'Allocate payment', exact: true }).click();
    const undo = allocations.getByRole('button', { name: 'Deallocate ' + number, exact: true });
    await expect(undo).toBeVisible();
    await expect(allocations.getByRole('row')).toHaveCount(before === 0 ? 2 : before + 1);
    await undo.click();
    const dialog = finance.page.getByRole('dialog', { name: 'Deallocate ' + number, exact: true });
    const reason = dialog.getByLabel('Reason for deallocating', { exact: true });
    await expect(reason).toHaveAttribute('required', '');
    await dialog.getByRole('button', { name: 'Deallocate', exact: true }).click();
    await expect(reason).toBeFocused();
    const note = 'Linux P3 browser reversal ' + Date.now();
    await reason.fill(note);
    await dialog.getByRole('button', { name: 'Deallocate', exact: true }).click();
    // Server revalidation may replace the successful dialog with the updated page immediately.
    await expect(allocations.getByText('Reversed: ' + note, { exact: true })).toBeVisible();
    await expect(allocations.getByRole('row')).toHaveCount(before === 0 ? 3 : before + 2);
    await expect(
      allocations.getByRole('button', { name: 'Deallocate ' + number, exact: true }),
    ).toHaveCount(0);
    await expect(
      allocations
        .getByRole('row')
        .filter({ hasText: 'Reversed: ' + note })
        .getByRole('cell')
        .nth(1),
    ).toHaveText('NPR -1.00');
  } finally {
    await finance.context.close();
  }
});
