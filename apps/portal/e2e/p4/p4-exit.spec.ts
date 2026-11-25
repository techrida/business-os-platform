import { expect, test } from '@playwright/test';

import { minimalPdf } from '../../../workspace/e2e/helpers/pdf-fixture';
import { signInAs, type Signed } from '../../../workspace/e2e/helpers/memo-flow';
import { fillDateField } from '../helpers/date-fields';

/**
 * Journey 11 portal checkpoints on a disposable real stack, explicitly enabled by
 * BOS_E2E_P4_EXIT=1. PORTAL_E2E_BASE_URL and PORTAL_E2E_VENDOR_STATE are the normal portal inputs
 * (the latter is a real signed-in approved vendor's storage state, never a fabricated cookie).
 *
 * Upload round trip: BOS_E2E_P4_EXIT_WORKSPACE_URL, BOS_E2E_P4_EXIT_OPEN_RFQ_ID (open and inviting
 * this vendor), BOS_E2E_P4_EXIT_PO_ID (this vendor's issued/received PO). The normal persona file
 * must contain procurement and accountant, with access to the same entity. UI submissions create
 * inbox rows and their clean scans/convert links are observed in the real workspace. They are not
 * automatically approved bills or quotations. Use a fresh RFQ on each run.
 *
 * Completed outcome: BOS_E2E_P4_EXIT_PO_ID and BOS_E2E_P4_EXIT_BILL_ID identify ONE Journey 11 PO
 * with two serialized goods fully received and its approved bill; PDF render/scan must be complete.
 * PORTAL_E2E_VENDOR_B_STATE is a second approved vendor's real session in the same entity;
 * PORTAL_E2E_PENDING_STATE is a pending_kyc vendor's real session. Boundary scenarios skip
 * independently until their explicit state file is supplied. No test writes those state files.
 */
const base = process.env.PORTAL_E2E_BASE_URL;
const vendorState = process.env.PORTAL_E2E_VENDOR_STATE;
const vendorBState = process.env.PORTAL_E2E_VENDOR_B_STATE;
const pendingState = process.env.PORTAL_E2E_PENDING_STATE;
const workspace = process.env.BOS_E2E_P4_EXIT_WORKSPACE_URL;
const openRfqId = process.env.BOS_E2E_P4_EXIT_OPEN_RFQ_ID;
const poId = process.env.BOS_E2E_P4_EXIT_PO_ID;
const billId = process.env.BOS_E2E_P4_EXIT_BILL_ID;

test.skip(
  process.env.BOS_E2E_P4_EXIT !== '1' || !base || !vendorState,
  'set BOS_E2E_P4_EXIT=1, PORTAL_E2E_BASE_URL and PORTAL_E2E_VENDOR_STATE',
);
if (vendorState) test.use({ baseURL: base, storageState: vendorState });

const INTERNAL = /\b(comparison|variance|ledger|cost centre|budget|balance|outstanding)\b/i;

test('vendor quotation and invoice uploads reach the actual workspace inboxes with clean files', async ({
  page,
  browser,
}) => {
  test.skip(
    !workspace || !openRfqId || !poId,
    'set BOS_E2E_P4_EXIT_WORKSPACE_URL, OPEN_RFQ_ID and PO_ID for the upload round trip',
  );
  test.setTimeout(420_000);
  const opened: Signed[] = [];
  const reference = `P4-EXIT-${Date.now()}`;
  try {
    await test.step('the vendor sends the NPR 120000 quotation through the RFQ UI', async () => {
      await page.goto('/vendor/rfqs');
      await page.locator(`a[href="/vendor/rfqs/${openRfqId}"]`).click();
      await page.getByRole('link', { name: 'Submit quotation', exact: true }).click();
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Your quotation', { exact: true }).setInputFiles({
        name: 'p4-exit-quotation.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('Journey 11 vendor quotation'),
      });
      await expect(page.getByRole('list', { name: 'Uploaded file' })).toContainText(
        'p4-exit-quotation.pdf',
      );
      await page.getByLabel('Total of your quotation').pressSequentially('120000.00');
      await page.getByLabel(/^Your reference/).fill(reference);
      await page.getByLabel(/^Delivery time in days/).fill('14');
      await page.getByRole('button', { name: 'Submit quotation', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'We received your quotation' }),
      ).toBeVisible();
    });

    await test.step('procurement sees the real quotation submission ready for conversion', async () => {
      const procurement = await signInAs(browser, workspace ?? '', 'procurement');
      opened.push(procurement);
      await procurement.page.goto(`/procurement/rfqs/${openRfqId}`);
      const row = procurement.page
        .getByRole('table', { name: 'Vendor submissions waiting to be converted' })
        .getByRole('row')
        .filter({ hasText: reference });
      await expect(async () => {
        await procurement.page.reload();
        await expect(row.getByRole('link', { name: /^Convert the submission from / })).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 120_000 });
      await expect(row).toHaveCount(1);
    });

    await test.step('the vendor sends an invoice linked to its order', async () => {
      await page.goto(`/vendor/purchase-orders/${poId}`);
      await page.getByRole('link', { name: 'Submit a bill', exact: true }).click();
      await page.waitForLoadState('networkidle');
      // The app's dropdown keeps its value in a hidden input of the same name.
      await expect(page.locator('input[type="hidden"][name="purchaseOrderId"]')).toHaveValue(
        poId ?? '',
      );
      await page.getByLabel('Your bill', { exact: true }).setInputFiles({
        name: 'p4-exit-invoice.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('Journey 11 vendor invoice'),
      });
      await expect(page.getByRole('list', { name: 'Uploaded file' })).toContainText(
        'p4-exit-invoice.pdf',
      );
      await page.getByLabel('Your invoice number').fill(reference);
      // Use the form's Kathmandu "today" limit rather than a date that will eventually be future.
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kathmandu' }).format(
        new Date(),
      );
      await fillDateField(page, 'Invoice date', today);
      await page.getByLabel('Total on your invoice').pressSequentially('120000.00');
      await page.getByRole('button', { name: 'Submit bill', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'We received your bill' }),
      ).toBeVisible();
    });

    await test.step('accounting sees that invoice in its inbox, ready to create a bill', async () => {
      const accountant = await signInAs(browser, workspace ?? '', 'accountant');
      opened.push(accountant);
      await accountant.page.goto('/payables/inbox');
      const row = accountant.page
        .getByRole('table', { name: 'Vendor invoice submissions, oldest first' })
        .getByRole('row')
        .filter({ hasText: reference });
      await expect(async () => {
        await accountant.page.reload();
        await expect(row.getByRole('link', { name: 'Create bill', exact: true })).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 120_000 });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Against an order');
      await expect(row).toContainText('Scanned clean');
    });
  } finally {
    await Promise.all(opened.map(({ context }) => context.close()));
  }
});

test('the vendor sees the fully received order PDF and its bill approved for payment', async ({
  page,
}) => {
  test.skip(!poId || !billId, 'set BOS_E2E_P4_EXIT_PO_ID and BILL_ID for the completed Journey 11');
  await page.goto('/vendor/purchase-orders');
  await page.locator(`a[href="/vendor/purchase-orders/${poId}"]`).click();
  await expect(page.getByText('Fully received', { exact: true })).toBeVisible();
  const items = page.getByRole('table', { name: /^Items on / });
  await expect(items).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(INTERNAL);
  const pdf = await page.request.get(`/vendor/purchase-orders/${poId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  await page.goto('/vendor/bills');
  await page.locator(`a[href="/vendor/bills/${billId}"]`).click();
  await expect(page.getByText('Approved for payment', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  await expect(
    page.getByText('No payments have been made against this bill yet.', { exact: true }),
  ).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(INTERNAL);
});

test.describe('another approved vendor', () => {
  test.skip(
    !vendorBState || !poId || !billId,
    'set PORTAL_E2E_VENDOR_B_STATE and Journey 11 PO_ID/BILL_ID',
  );
  if (vendorBState) test.use({ storageState: vendorBState });

  test('cannot open the journey order, bill, or PDF', async ({ page }) => {
    for (const path of [`/vendor/purchase-orders/${poId}`, `/vendor/bills/${billId}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    }
    const pdf = await page.request.get(`/vendor/purchase-orders/${poId}/pdf`);
    expect(pdf.status()).toBe(404);
  });
});

test.describe('a vendor awaiting KYC', () => {
  test.skip(!pendingState, 'set PORTAL_E2E_PENDING_STATE for a pending_kyc vendor');
  if (pendingState) test.use({ storageState: pendingState });

  test('can open KYC upload but cannot use order, invoice or quotation pages', async ({ page }) => {
    await page.goto('/vendor');
    const nav = page.getByRole('navigation', { name: 'Vendor portal', exact: true });
    await expect(nav.getByRole('link', { name: 'Onboarding', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Purchase orders', exact: true })).toHaveCount(0);
    await page.goto('/vendor/onboarding/upload');
    await expect(page.getByRole('heading', { level: 1, name: 'Send a document' })).toBeVisible();
    for (const path of ['/vendor/purchase-orders', '/vendor/bills/new', '/vendor/rfqs']) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', {
          name: 'Your vendor account cannot use this page',
          exact: true,
        }),
      ).toBeVisible();
    }
  });
});
