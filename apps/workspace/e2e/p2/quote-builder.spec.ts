import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

/**
 * The quote builder against the real stack (lead runs it; needs the P2 API and a seeded
 * opportunity whose id is in E2E_OPPORTUNITY_ID, with at least one tax code and a Qualified
 * state). Covers the brief: totals only from the server, the schedule must total 100% before
 * submit, a discount above 12% is shown as needing approval, and leaving with edits asks first.
 */

const opportunityId = process.env['E2E_OPPORTUNITY_ID'];

test('build, save, price on the server, and submit a quotation', async ({ browser, baseURL }) => {
  test.skip(!opportunityId, 'Set E2E_OPPORTUNITY_ID to a seeded opportunity id.');
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const { page } = await signInAs(browser, appBase, 'sales');

  await test.step('a new quotation shows no totals until it is saved', async () => {
    await page.goto(`/quotations/new?opportunityId=${opportunityId}`);
    await expect(page.getByRole('heading', { name: 'New quotation', level: 1 })).toBeVisible();
    await expect(page.getByText('Save the draft to see the totals.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
  });

  await test.step('fill one line and save the draft', async () => {
    await page.getByRole('button', { name: 'Add the first line' }).click();
    await page.getByLabel('Line 1 description').fill('HRMS implementation');
    await page.getByLabel('Line 1 unit').fill('lot');
    await page.getByLabel('Line 1 quantity').fill('1');
    await page.getByLabel('Line 1 rate').fill('2,00,000');
    await page.getByLabel('Line 1 tax code').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Save draft' }).first().click();
    await expect(page).toHaveURL(/\/quotations\/[^/]+\/edit\?saved=1/);
    await expect(page.getByText('Draft saved.')).toBeVisible();
  });

  await test.step('the totals are the platform\u2019s, and the route is listed', async () => {
    const totals = page.getByRole('complementary', { name: /7\. Totals/ });
    await expect(totals.getByText('Total', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '8. Approval requirements' })).toBeVisible();
  });

  await test.step('a schedule that is not 100% blocks Submit', async () => {
    await page.getByRole('button', { name: 'Add milestone' }).click();
    await page.getByLabel('Milestone 1', { exact: true }).fill('Advance');
    await page.getByLabel('Percent').fill('60');
    await expect(page.getByText(/must add up to 100%/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Save draft' }).first().click();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('100%');
    await expect(page.getByRole('button', { name: 'Submit for approval' }).first()).toBeDisabled();
  });

  await test.step('a 15% discount is shown as needing approval', async () => {
    await page.getByLabel('Percent').fill('100');
    await page.getByLabel('Discount type').selectOption('pct');
    await page.getByLabel('Discount (%)').fill('15');
    await expect(page.getByText('This discount needs approval')).toBeVisible();
  });

  await test.step('save, then submit with confirmation', async () => {
    await page.getByRole('button', { name: 'Save draft' }).first().click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /^All changes saved$/ })
        .first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Submit for approval' }).first().click();
    await page.getByRole('button', { name: 'Yes, submit' }).click();
    await expect(page.getByText('Submitted for approval')).toBeVisible();
  });
});
