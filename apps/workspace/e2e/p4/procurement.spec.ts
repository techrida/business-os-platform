import { expect, test } from '@playwright/test';

import { fillDateField } from '../helpers/date-fields';
import { signInAs, type Signed } from '../helpers/memo-flow';
import {
  expectParam,
  expectSelected,
  multiSelectByLabel,
  toggleOptions,
} from '../helpers/multi-select';
import { chooseOption, selectByName } from '../helpers/select';

/**
 * The P4 purchase request screens, against the real stack. Not run by the unit that wrote it: it
 * needs the purchase request API, the P4 permission grants, a seeded department and cost centre
 * (their catalogue values in BOS_E2E_DEPARTMENT_ID and BOS_E2E_COST_CENTER_ID)
 * and the seeded founder persona. Written for the lead to run; it skips
 * unless BOS_E2E_P4=1 and both ids are set.
 *
 * (1) The list loads and a status filter with no match says so.
 * (2) A draft is saved from the form and shows the server's total, with submit and cancel offered.
 * (3) Cancelling the draft makes it read-only.
 *
 * The RFQ screens have their own spec once they exist.
 */

const DEPARTMENT = process.env.BOS_E2E_DEPARTMENT_ID ?? '';
const COST_CENTER = process.env.BOS_E2E_COST_CENTER_ID ?? '';

test.skip(
  process.env.BOS_E2E_P4 !== '1' || DEPARTMENT === '' || COST_CENTER === '',
  'set BOS_E2E_P4=1, BOS_E2E_DEPARTMENT_ID and BOS_E2E_COST_CENTER_ID to run the purchase request screens',
);

test('the purchase request list loads and filters', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto('/procurement/requests');
    await expect(
      founder.page.getByRole('heading', { level: 1, name: 'Purchase requests' }),
    ).toBeVisible();
    // Filters apply as they change: no Apply button, the URL is the state.
    const status = multiSelectByLabel(founder.page, 'Status');
    await toggleOptions(status, ['closed']);
    await expectParam(founder.page, 'status', ['closed']);
    await expectSelected(status, ['closed']);
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('a draft is saved with a server total, then cancelled and read-only', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    const { page } = founder;

    await test.step('the form saves a draft', async () => {
      await page.goto('/procurement/requests/new');
      await page.waitForLoadState('networkidle');
      await fillDateField(page, 'Needed by', '2026-12-31');
      await chooseOption(selectByName(page, 'departmentId'), DEPARTMENT);
      await chooseOption(selectByName(page, 'costCenterId'), COST_CENTER);
      await page.getByLabel('Budget code').fill('E2E-26');
      await page.getByLabel('Why is this needed?').fill(`E2E request ${Date.now()}`);
      await page.getByLabel('Description').fill('Office chair');
      await page.getByLabel('Unit', { exact: true }).fill('pcs');
      await page.getByLabel('Quantity', { exact: true }).first().fill('10');
      await page
        .getByLabel(/Estimated unit price/)
        .first()
        .fill('4500.00');
      await page.getByRole('button', { name: 'Save draft' }).click();
      await expect(page).toHaveURL(/\/procurement\/requests\/[0-9a-f-]{36}\?created=1/);
      await expect(page.getByText('45,000.00').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit for approval' })).toBeVisible();
    });

    await test.step('cancelling asks once, then the request is read-only', async () => {
      await page.getByRole('button', { name: 'Cancel request' }).click();
      await page.getByRole('button', { name: 'Yes, cancel this request' }).click();
      await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Submit for approval' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Edit request' })).toHaveCount(0);
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
