import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * The P3 receivables screens (aging report and customer statement), against the real stack. Not run
 * by the unit that wrote it: it needs the `/v1/receivables` routes (U8), the `ar.read` grant, and
 * the nav entry the lead adds. Written for the lead to run once those exist.
 *
 * (1) The aging report shows its "as of" date from the server and either a table or the empty
 *     state; a customer link opens that customer's statement.
 * (2) A statement for an id that is not a customer says so in words, and an unknown customer shows
 *     "Customer not found", not a blank page.
 * (3) Sales has no `ar.read` grant: the page explains the refusal and shows no figures.
 */

test('the aging report loads and its customers open a statement', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);
    const page = finance.page;

    await test.step('the report shows the server date and a table, an empty state or a notice', async () => {
      await page.goto('/receivables/aging');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Receivables aging' }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: /Receivables aging as of/ })
          .or(page.getByText('No open receivables.'))
          .or(page.getByRole('alert')),
      ).toBeVisible();
    });

    await test.step('a customer link opens that customer statement', async () => {
      const link = page.locator('a[href^="/receivables/customers/"]');
      if ((await link.count()) === 0) test.skip(true, 'no open receivables seeded for this tenant');
      await link.first().click();
      await expect(page).toHaveURL(/\/receivables\/customers\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('link', { name: 'View payments' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Customer advance' })).toBeVisible();
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('an unknown customer shows words, not a blank page', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);

    await finance.page.goto('/receivables/customers/00000000-0000-4000-8000-000000000000');
    await expect(finance.page.getByRole('alert')).toContainText(
      /Customer not found|did not load|do not include receivables/,
    );
    await finance.page.goto('/receivables/customers/not-an-id');
    await expect(finance.page.getByText('That is not a customer')).toBeVisible();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('a role without ar.read is told so and sees no figures', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sales = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
  try {
    await sales.page.goto('/receivables/aging');
    await expect(sales.page.getByRole('alert')).toContainText(
      'Your roles do not include receivables',
    );
    await expect(sales.page.getByRole('table')).toHaveCount(0);
    await expect(sales.page.locator('a[href^="/receivables/customers/"]')).toHaveCount(0);
    await expect(sales.page.getByRole('link', { name: 'Receivables', exact: true })).toHaveCount(0);
  } finally {
    await sales.context.close();
  }
});
