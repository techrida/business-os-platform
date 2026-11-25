import { expect, test } from '@playwright/test';

import { approveInboxRequest } from '../helpers/fixture-flow';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { chooseOption, selectByName } from '../helpers/select';
import { fillDateField } from '../helpers/date-fields';

/**
 * Journey 11 browser checkpoints against the real, disposable P4 stack. No API is mocked.
 * Set BOS_E2E_P4_EXIT=1 explicitly; ordinary P4 screen runs do not mutate these fixtures.
 *
 * The first scenario builds a PR and RFQ through the UI. It needs the normal seed personas
 * procurement/depthead, BOS_E2E_DEPARTMENT_ID (headed by depthead), BOS_E2E_COST_CENTER_ID,
 * and BOS_E2E_P4_EXIT_VENDOR_IDS (three comma-separated approved vendors with entity accounts).
 *
 * The completed-journey scenario needs BOS_E2E_P4_EXIT_{PR,RFQ,PO,RECEIPT,BILL,VENDOR}_ID and
 * BOS_E2E_P4_EXIT_SERIALS (two comma-separated serial numbers). These must describe ONE connected
 * Journey 11: normal approved PR, three invited vendors, NPR 120000 recommended quote with three
 * approved commitment steps, fully received PO with a clean v1 PDF, confirmed two-serial receipt,
 * and an approved, matched bill. The qa workflow makes them through the product screens
 * (e2e/p4/qa-fixtures-p4-exit.spec.ts) and .github/qa/export-ids.sh exports the ids; elsewhere,
 * provision these milestones separately. Browser checkpoints alone do not prove their creation.
 * BASE_URL/BOS_DEV_PERSONAS_FILE/BOS_E2E_CA_FILE follow the existing workspace runner.
 */
const enabled = process.env.BOS_E2E_P4_EXIT === '1';
const departmentId = process.env.BOS_E2E_DEPARTMENT_ID ?? '';
const costCenterId = process.env.BOS_E2E_COST_CENTER_ID ?? '';
const vendorIds = (process.env.BOS_E2E_P4_EXIT_VENDOR_IDS ?? '').split(',').filter(Boolean);
const prId = process.env.BOS_E2E_P4_EXIT_PR_ID ?? '';
const rfqId = process.env.BOS_E2E_P4_EXIT_RFQ_ID ?? '';
const poId = process.env.BOS_E2E_P4_EXIT_PO_ID ?? '';
const receiptId = process.env.BOS_E2E_P4_EXIT_RECEIPT_ID ?? '';
const billId = process.env.BOS_E2E_P4_EXIT_BILL_ID ?? '';
const vendorId = process.env.BOS_E2E_P4_EXIT_VENDOR_ID ?? '';
const serials = (process.env.BOS_E2E_P4_EXIT_SERIALS ?? '').split(',').filter(Boolean);

test.skip(!enabled, 'set BOS_E2E_P4_EXIT=1 against a disposable, seeded P4 stack');

test('procurement raises a PR, its department head alone approves, then three vendors are invited', async ({
  browser,
  baseURL,
}) => {
  test.skip(
    !departmentId || !costCenterId || vendorIds.length !== 3,
    'set BOS_E2E_DEPARTMENT_ID, BOS_E2E_COST_CENTER_ID and BOS_E2E_P4_EXIT_VENDOR_IDS (3 approved vendors)',
  );
  // Two persona sign-ins (each waits for a fresh TOTP window), the request, its approval and the RFQ.
  test.setTimeout(480_000);
  expect(new Set(vendorIds).size, 'three distinct invited vendors').toBe(3);
  const opened: Signed[] = [];
  const appBase = baseURL ?? 'https://app.localhost';
  try {
    const procurement = await signInAs(browser, appBase, 'procurement');
    opened.push(procurement);
    const page = procurement.page;

    const requestPath =
      await test.step('procurement saves and submits the purchase request', async () => {
        await page.goto('/procurement/requests/new');
        await page.waitForLoadState('networkidle');
        await fillDateField(page, 'Needed by', '2030-12-31');
        await chooseOption(selectByName(page, 'departmentId'), departmentId);
        await chooseOption(selectByName(page, 'costCenterId'), costCenterId);
        await page.getByLabel('Budget code').fill('P4-EXIT');
        await page.getByLabel('Why is this needed?').fill(`Journey 11 browser ${Date.now()}`);
        await page.getByLabel('Description', { exact: true }).fill('Two serialized devices');
        await page.getByLabel('Unit', { exact: true }).fill('pcs');
        await page.getByLabel('Quantity', { exact: true }).fill('2');
        await page.getByLabel(/Estimated unit price/).fill('60000.00');
        await page.getByRole('checkbox', { name: 'Record serial numbers at receipt' }).check();
        await page.getByRole('button', { name: 'Save draft', exact: true }).click();
        await expect(page).toHaveURL(/\/procurement\/requests\/[0-9a-f-]{36}\?created=1$/);
        const pathname = new URL(page.url()).pathname;
        await page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
        await page
          .getByRole('dialog', { name: 'Submit for approval?' })
          .getByRole('button', { name: 'Submit for approval', exact: true })
          .click();
        await expect(page.getByText('Awaiting approval', { exact: true })).toBeVisible();
        // The region also lists who acted, so the route's one step is counted by its routing reason.
        await expect(
          page.getByRole('region', { name: 'Approval', exact: true }).getByRole('listitem').filter({
            hasText: 'Base route: the head of the requesting department approves the need',
          }),
        ).toHaveCount(1);
        return pathname;
      });
    const number = await page.getByRole('heading', { level: 1 }).innerText();

    await test.step('a different department-head persona approves the only step', async () => {
      const head = await signInAs(browser, appBase, 'depthead');
      opened.push(head);
      await approveInboxRequest(head.page, number, 'Journey 11 browser approval');
      await page.goto(requestPath);
      await expect(page.getByText('Department approved', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Approval', exact: true }).getByRole('listitem').filter({
          hasText: 'Base route: the head of the requesting department approves the need',
        }),
      ).toHaveCount(1);
    });

    await test.step('procurement opens the RFQ for precisely those three vendors', async () => {
      await page.getByRole('link', { name: 'Start RFQ', exact: true }).click();
      await page.waitForLoadState('networkidle');
      await fillDateField(page, 'Quotation deadline', '2030-12-01', '17:00');
      // The checkboxes are the app's own control (the form input is hidden); the list offers exactly the approved
      // vendors, and the three ids above are the ones the stack seeds.
      const offered = page.getByRole('group', { name: /Invited vendors/ }).getByRole('checkbox');
      await expect(offered).toHaveCount(vendorIds.length);
      for (const box of await offered.all()) await box.check();
      await page.getByRole('button', { name: 'Open RFQ', exact: true }).click();
      await expect(page).toHaveURL(/\/procurement\/rfqs\/[0-9a-f-]{36}\?created=1$/);
      await expect(page.getByText('Invited vendors (3)', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'RFQ', exact: true }).locator(`a[href="${requestPath}"]`),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Enter a quotation', exact: true }),
      ).toBeVisible();
    });
  } finally {
    await Promise.all(opened.map(({ context }) => context.close()));
  }
});

test('the completed Journey 11 remains connected across requests, sourcing, receipts and payables', async ({
  browser,
  baseURL,
}) => {
  test.skip(
    !prId || !rfqId || !poId || !receiptId || !billId || !vendorId || serials.length !== 2,
    'set all BOS_E2E_P4_EXIT document IDs, VENDOR_ID and SERIALS for one completed Journey 11',
  );
  test.setTimeout(180_000);
  const founder = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  const { page } = founder;
  try {
    await test.step('the purchase request links to its three-vendor RFQ and approval routes are complete', async () => {
      await page.goto(`/procurement/requests/${prId}`);
      const approval = page.getByRole('region', { name: 'Approval', exact: true });
      await expect(
        approval.getByRole('listitem').filter({
          hasText: 'Base route: the head of the requesting department approves the need',
        }),
      ).toHaveCount(1);
      await expect(approval).toContainText('Approved on');
      await page.getByRole('link', { name: 'Open RFQ', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/procurement/rfqs/${rfqId}$`));
      await expect(page.getByText('Invited vendors (3)', { exact: true })).toBeVisible();
      const recommended = page
        .getByRole('table', { name: 'Quotations received' })
        .getByRole('row')
        .filter({ hasText: 'Recommended' });
      await expect(recommended).toHaveCount(1);
      await expect(recommended).toContainText('1,20,000.00');
      const commitment = page.getByRole('region', { name: 'Commitment approval', exact: true });
      await expect(commitment).toContainText('Approval approved');
      // The UI displays each step's routing reason; the API journey verifies its roleKey.
      const stepReasons = [
        'Base route: an Accountant checks the recommended quotation',
        'Base route: Finance commits the budget',
        'Commitment of NPR 120,000.00 is above NPR 100,000.00',
      ];
      for (const [index, reason] of stepReasons.entries()) {
        const step = commitment.getByRole('listitem').filter({ hasText: reason });
        await expect(step, `step ${index + 1}`).toHaveCount(1);
        await expect(step).toContainText('Approved');
      }
    });

    await test.step('the fully received order exposes its clean PDF, vendor link and confirmed serial receipt', async () => {
      await page.goto(`/procurement/orders/${poId}`);
      await expect(page.getByText('Fully received', { exact: true })).toBeVisible();
      const vendor = page.locator(`main a[href="/vendors/${vendorId}"]`);
      await expect(vendor).toBeVisible();
      await vendor.click();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Profile', exact: true })).toBeVisible();
      await page.goto(`/procurement/orders/${poId}`);
      // "Download of version 1" is a button that downloads in the app; the file is the document route of the version.
      await expect(
        page.getByRole('button', { name: 'Download of version 1', exact: true }),
      ).toBeVisible();
      const response = await page.request.get(`/procurement/orders/${poId}/versions/1/document`);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/pdf');
      await page.locator('main').getByRole('link', { name: 'Receipts', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/procurement/receipts\\?po=${poId}$`));
      await page.locator(`main a[href="/procurement/receipts/${receiptId}"]`).click();
      await expect(
        page
          .getByRole('heading', { level: 1 })
          .locator('..')
          .getByText('Confirmed', { exact: true }),
      ).toBeVisible();
      const serialDetails = page.locator('main details');
      for (const details of await serialDetails.all()) await details.locator('summary').click();
      await expect(serialDetails.getByRole('listitem')).toHaveCount(2);
      for (const serial of serials)
        await expect(page.getByRole('listitem').filter({ hasText: serial })).toBeVisible();
    });

    await test.step('the approved bill is matched and points to the same order and vendor', async () => {
      await page.goto(`/payables/bills/${billId}`);
      // The bill's own status badge, in the page header: the approval history repeats the word for each step.
      await expect(
        page
          .getByRole('heading', { level: 1 })
          .locator('..')
          .getByText('Approved', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('table', { name: 'Match result by bill line' })).toContainText(
        'Matched',
      );
      await expect(page.locator(`main a[href="/procurement/orders/${poId}"]`)).toBeVisible();
      await expect(page.locator(`main a[href="/vendors/${vendorId}"]`)).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Submit for approval', exact: true }),
      ).toHaveCount(0);
    });
  } finally {
    await founder.context.close();
  }
});

test('accounting and warehouse open their journey documents while forbidden pages explain role limits', async ({
  browser,
  baseURL,
}) => {
  test.skip(!billId || !rfqId || !receiptId, 'set BOS_E2E_P4_EXIT_BILL_ID, RFQ_ID and RECEIPT_ID');
  test.setTimeout(180_000);
  const opened: Signed[] = [];
  try {
    const accountant = await signInAs(browser, baseURL ?? 'https://app.localhost', 'accountant');
    opened.push(accountant);
    await accountant.page.goto(`/payables/bills/${billId}`);
    await expect(accountant.page.getByRole('table', { name: 'Bill lines' })).toBeVisible();
    await accountant.page.goto(`/procurement/rfqs/${rfqId}`);
    await expect(
      accountant.page.getByText('Your roles do not include sourcing', { exact: true }),
    ).toBeVisible();
    await expect(accountant.page.getByRole('link', { name: 'Enter a quotation' })).toHaveCount(0);
    const warehouse = await signInAs(browser, baseURL ?? 'https://app.localhost', 'warehouse');
    opened.push(warehouse);
    await warehouse.page.goto(`/procurement/receipts/${receiptId}`);
    await expect(warehouse.page.getByRole('table', { name: 'Receipt lines' })).toBeVisible();
    await warehouse.page.goto(`/payables/bills/${billId}`);
    await expect(
      warehouse.page.getByText('You cannot open this bill', { exact: true }),
    ).toBeVisible();
    await expect(warehouse.page.getByRole('table', { name: 'Bill lines' })).toHaveCount(0);
  } finally {
    await Promise.all(opened.map(({ context }) => context.close()));
  }
});
