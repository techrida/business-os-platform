import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';

/**
 * The P2 customer and KYB screens, against the real stack. Not run by the unit that wrote it: it
 * needs the customer and verification API routes, the K3 permission grants (until they land every
 * P2 nav entry is hidden on purpose), and a case in the review queue. Written for the lead to run
 * once those exist; see the hand-back for the command.
 *
 * (1) The founder sees the CRM nav entries and the customer list loads, search included.
 * (2) The 403 wording is a fixme: K3 gives every staff persona `customer.read`, so no seeded persona
 *     can reach it. Add a persona without it (or a role-edit step) to turn it on.
 * (3) The KYB queue opens a case, and deciding without a reason is refused in place.
 */

test('the customer list loads and searches', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);

    await test.step('the CRM group lists Customers and Verification', async () => {
      await founder.page.goto('/');
      const nav = founder.page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link', { name: 'Customers' })).toBeVisible();
      await expect(nav.getByRole('link', { name: 'Verification' })).toBeVisible();
    });

    await test.step('the list shows a table or an empty state, and the search keeps its text', async () => {
      await founder.page.goto('/customers');
      await expect(
        founder.page.getByRole('heading', { level: 1, name: 'Customers' }),
      ).toBeVisible();
      await founder.page.getByLabel('Search customers').fill('no-such-customer-xyz');
      await founder.page.getByRole('button', { name: 'Search' }).click();
      await expect(founder.page).toHaveURL(/q=no-such-customer-xyz/);
      await expect(
        founder.page.getByText('No customers match "no-such-customer-xyz".'),
      ).toBeVisible();
      await expect(founder.page.getByLabel('Search customers')).toHaveValue('no-such-customer-xyz');
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test.fixme('a role without customer access sees words, not a blank page', () => {
  // Needs a seeded staff persona with no `customer.read`; none exists after K3.
});

test('the KYB queue opens a case and refuses a decision without a reason', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const reviewer = await signInAs(browser, appBase, 'founder');

  try {
    const page = reviewer.page;
    await page.goto('/verification');
    await expect(page.getByRole('heading', { level: 1, name: 'Verification' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Awaiting review' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const firstCase = page
      .getByRole('table', { name: 'Verification cases' })
      .getByRole('link')
      .first();
    test.skip(
      (await firstCase.count()) === 0,
      'No case is awaiting review: seed a submitted verification case to run this.',
    );

    await firstCase.click();
    await expect(page.getByRole('table', { name: 'Verification documents' })).toBeVisible();

    // No reason: refused in place, with the field named, and nothing is sent to the API.
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(
      page.getByText('Say why you are rejecting. The reason is kept in the audit trail.'),
    ).toBeVisible();
  } finally {
    await reviewer.context.close();
  }
});
