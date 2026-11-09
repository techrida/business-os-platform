import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * The P3 payments screens (list and detail), against the real stack. Not run by the unit that wrote
 * it: it needs the `/v1/payments` routes (U7), the payment permission grants, and the nav entry the
 * lead adds. Written for the lead to run once those exist.
 *
 * (1) Finance opens the list; the status filter keeps its choice in the URL and an empty filter
 *     says so in words.
 * (2) A payment id that does not exist shows "Payment not found", not a blank page.
 * (3) A payment the signed-in person recorded cannot be verified by them: the refusal is shown in
 *     the dialog in plain words. Fixme until a seeded submitted payment exists for a persona.
 */

test('the payments list loads and its status filter keeps the choice', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);

    await test.step('the list shows a table or an empty state', async () => {
      await finance.page.goto('/payments');
      await expect(finance.page.getByRole('heading', { level: 1, name: 'Payments' })).toBeVisible();
      await expect(
        finance.page
          .getByRole('region', { name: /Payments/ })
          .or(finance.page.getByText('No payments yet.'))
          .or(finance.page.getByRole('alert')),
      ).toBeVisible();
    });

    await test.step('filtering by status updates the URL and the select', async () => {
      await finance.page.getByLabel('Status').selectOption('rejected');
      await finance.page.getByRole('button', { name: 'Apply filter' }).click();
      await expect(finance.page).toHaveURL(/status=rejected/);
      await expect(finance.page.getByLabel('Status')).toHaveValue('rejected');
      await expect(finance.page.getByRole('link', { name: 'Show all payments' })).toBeVisible();
    });

    await test.step('a hand-edited filter is ignored, not sent to the API', async () => {
      await finance.page.goto('/payments?status=bogus');
      await expect(finance.page.getByLabel('Status')).toHaveValue('');
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('an unknown payment shows words, not a blank page', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);

    await finance.page.goto('/payments/00000000-0000-4000-8000-000000000000');
    await expect(finance.page.getByRole('alert')).toContainText(/Payment not found|did not load/);
    await finance.page.goto('/payments/not-an-id');
    await expect(finance.page.getByText('That is not a payment')).toBeVisible();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test.fixme('the person who recorded a payment cannot verify it', () => {
  // Needs a seeded submitted payment recorded by the signed-in persona. Steps: open the payment,
  // choose Verify payment, confirm; expect the dialog alert to say "You recorded this payment, so
  // someone else in Finance must verify it" and the status to stay "Awaiting verification".
});
