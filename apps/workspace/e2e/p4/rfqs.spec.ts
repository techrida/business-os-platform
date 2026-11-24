import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';
import {
  expectParam,
  expectSelected,
  multiSelectByLabel,
  toggleOptions,
} from '../helpers/multi-select';
import { fillDateField } from '../helpers/date-fields';

/**
 * The P4 RFQ screens, against the real stack. Not run by the unit that wrote it: it needs the
 * sourcing API, the P4 permission grants, at least one approved vendor with an account in the
 * entity, and one purchase request the department head already approved (its id in
 * BOS_E2E_RFQ_PR_ID, because approving one is another persona's flow). It skips unless
 * BOS_E2E_P4=1 and that id is set.
 *
 * (1) The RFQ list loads and a status filter is kept in the URL.
 * (2) An RFQ is opened from the approved request: the deadline is typed in Kathmandu time, a
 *     vendor is invited, the RFQ page opens with its banner and offers quotation entry, and the
 *     purchase request now says "Open RFQ".
 *
 * Quotation entry and convert need an uploaded document id and a clean vendor submission, so they
 * are covered by the unit tests until the seed has them.
 */

const PR_ID = process.env.BOS_E2E_RFQ_PR_ID ?? '';

test.skip(
  process.env.BOS_E2E_P4 !== '1' || PR_ID === '',
  'set BOS_E2E_P4=1 and BOS_E2E_RFQ_PR_ID (a department-approved purchase request) to run the RFQ screens',
);

test('the RFQ list loads and keeps its filter in the URL', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    await founder.page.goto('/procurement/rfqs');
    await expect(
      founder.page.getByRole('heading', { level: 1, name: 'Requests for quotation' }),
    ).toBeVisible();
    // Filters apply as they change: no Apply button, the URL is the state.
    const status = multiSelectByLabel(founder.page, 'Status');
    await toggleOptions(status, ['cancelled']);
    await expectParam(founder.page, 'status', ['cancelled']);
    await expectSelected(status, ['cancelled']);
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('an RFQ is opened from an approved request', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  try {
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    const { page } = founder;

    await test.step('the form preselects the request and lists approved vendors', async () => {
      await page.goto(`/procurement/rfqs/new?pr=${PR_ID}`);
      await expect(page.locator('input[type="hidden"][name="purchaseRequestId"]')).toHaveValue(
        PR_ID,
      );
      await fillDateField(page, 'Quotation deadline', '2030-01-15', '17:00');
      await page
        .getByRole('group', { name: /Invited vendors/ })
        .getByRole('checkbox')
        .first()
        .check();
      await page.getByRole('button', { name: 'Open RFQ' }).click();
    });

    await test.step('the RFQ page opens with its banner and offers quotation entry', async () => {
      await expect(page).toHaveURL(/\/procurement\/rfqs\/[0-9a-f-]{36}\?created=1/);
      await expect(page.getByText('The RFQ was opened')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Enter a quotation' })).toBeVisible();
      await expect(page.getByText('No quotation has been recorded yet.')).toBeVisible();
    });

    await test.step('the purchase request now opens the RFQ instead of starting one', async () => {
      await page.goto(`/procurement/requests/${PR_ID}`);
      await expect(page.getByRole('link', { name: 'Open RFQ' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Start RFQ' })).toHaveCount(0);
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
