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
 *     keeps what was typed. Fixme until a seeded pair exists.
 * (3) Allocating then deallocating with a reason adds a reversal row. Fixme for the same reason.
 */

async function openFirstVerifiedPayment(finance: Signed): Promise<boolean> {
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

    const panel = finance.page.getByRole('region', { name: 'Allocate this payment' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Left on this payment')).toBeVisible();
    await expect(panel.getByText(/Customer advance in [A-Z]{3}/)).toBeVisible();

    const amounts = panel.getByRole('textbox', { name: /^Amount to allocate to / });
    test.skip((await amounts.count()) === 0, 'needs an open invoice for this customer');

    await test.step('a malformed amount is refused before it reaches the platform', async () => {
      await amounts.first().fill('12.345');
      await panel.getByRole('button', { name: 'Allocate payment' }).click();
      await expect(panel.getByText(/positive number with up to 2 decimals/)).toBeVisible();
      await expect(amounts.first()).toHaveAttribute('aria-invalid', 'true');
      await expect(amounts.first()).toHaveValue('12.345');
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

test.fixme('the server refuses more than an invoice has open, in words', () => {
  // Needs a seeded verified payment and an open invoice of the same customer and currency. Steps:
  // open the payment, type an amount above the invoice's open amount (or above what the payment has
  // left), choose Allocate payment; expect the alert to say "Nothing was allocated" with the
  // over-allocation wording, the typed amount to stay in the field, and the allocations table to be
  // unchanged. Then choose an invoice of another currency's customer (MISMATCHED_ITEMS) if seeded.
});

test.fixme('allocating then deallocating with a reason adds a reversal row', () => {
  // Needs the same seed. Steps: allocate part of the payment to one invoice; expect the success note
  // and a new row in the allocations table labelled with the invoice number; choose "Deallocate
  // <number>", leave the reason empty and submit (the browser stops it: the field is required), then
  // type a reason and submit; close the dialog; expect a second, negative row reading "Reversed:
  // <reason>" and no Deallocate button left on either row.
});
