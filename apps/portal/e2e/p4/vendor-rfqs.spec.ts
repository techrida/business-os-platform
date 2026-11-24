import { expect, test } from '@playwright/test';

import { minimalPdf } from '../../../workspace/e2e/helpers/pdf-fixture';
import { fillDateField } from '../helpers/date-fields';

/**
 * Vendor portal requests for quotation, end to end: the list, one request, and a quotation sent
 * for it. Needs a running portal and API with seed data and a signed-in vendor user's storage
 * state. The lead runs it; it skips itself when the inputs are missing. The submit test writes a
 * real quotation inbox row, so point it at a throwaway tenant.
 *
 *   PORTAL_E2E_BASE_URL            e.g. http://localhost:3002
 *   PORTAL_E2E_VENDOR_STATE        storage state of a signed-in, approved vendor user
 *   PORTAL_E2E_VENDOR_RFQ_ID       a request for quotation that vendor is invited to
 *   PORTAL_E2E_VENDOR_FOREIGN_ID   a request id of another vendor (or one that is closed)
 *   PORTAL_E2E_PENDING_STATE       storage state of a vendor still in onboarding (optional)
 */
const base = process.env.PORTAL_E2E_BASE_URL;
const storageState = process.env.PORTAL_E2E_VENDOR_STATE;
const rfqId = process.env.PORTAL_E2E_VENDOR_RFQ_ID;
const foreignId = process.env.PORTAL_E2E_VENDOR_FOREIGN_ID;
const pendingState = process.env.PORTAL_E2E_PENDING_STATE;

test.skip(!base || !storageState, 'PORTAL_E2E_BASE_URL and PORTAL_E2E_VENDOR_STATE are not set');
if (storageState) test.use({ storageState, baseURL: base });

const PDF = {
  name: 'quotation.pdf',
  mimeType: 'application/pdf',
  buffer: minimalPdf('P4 portal quotation'),
};
const stamp = () => Date.now().toString(36).toUpperCase();

test('lists the requests, opens one and goes on to the quotation form', async ({ page }) => {
  test.skip(!rfqId, 'PORTAL_E2E_VENDOR_RFQ_ID is not set');
  await page.goto('/vendor/rfqs');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Requests for quotation' }),
  ).toBeVisible();
  await page.locator(`a[href="/vendor/rfqs/${rfqId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/vendor/rfqs/${rfqId}$`));
  await page.getByRole('link', { name: 'Submit quotation' }).click();
  await expect(page).toHaveURL(new RegExp(`/vendor/rfqs/${rfqId}/quote$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Submit a quotation' })).toBeVisible();
  await expect(page.getByLabel('Your quotation', { exact: true })).toBeVisible();
});

test('refuses a quotation without a file or a total, naming the fields', async ({ page }) => {
  test.skip(!rfqId, 'PORTAL_E2E_VENDOR_RFQ_ID is not set');
  await page.goto(`/vendor/rfqs/${rfqId}/quote`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Total of your quotation').pressSequentially('twelve');
  await page.getByRole('button', { name: 'Submit quotation' }).click();
  await expect(page.getByText('Add your quotation as a PDF or a picture.')).toBeVisible();
  await expect(page.getByText(/Enter the total of your quotation/)).toBeVisible();
  // The total is a number box: letters never enter it, so what stays is empty and the refusal names it.
  await expect(page.getByLabel('Total of your quotation')).toHaveValue('');
});

test('refuses a delivery time that is not whole days, keeping what was typed', async ({ page }) => {
  test.skip(!rfqId, 'PORTAL_E2E_VENDOR_RFQ_ID is not set');
  await page.goto(`/vendor/rfqs/${rfqId}/quote`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Your quotation', { exact: true }).setInputFiles(PDF);
  await expect(page.getByRole('list', { name: 'Uploaded file' })).toContainText('quotation.pdf');
  await page.getByLabel('Total of your quotation').pressSequentially('2018180.00');
  const delivery = page.getByLabel(/^Delivery time in days/);
  // inputMode=numeric is a keyboard hint; this remains a text input for server validation.
  await delivery.fill('2w');
  await expect(delivery).toHaveValue('2w');
  await page.getByRole('button', { name: 'Submit quotation' }).click();
  await expect(page.getByText(/Enter the delivery time as a whole number of days/)).toBeVisible();
  await expect(page.getByLabel('Total of your quotation')).toHaveValue(/20,18,180(\.00)?/);
});

test('submits a quotation: the total is the vendor’s own text, and the answer confirms it', async ({
  page,
}) => {
  test.skip(!rfqId, 'PORTAL_E2E_VENDOR_RFQ_ID is not set');
  await page.goto(`/vendor/rfqs/${rfqId}/quote`);
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Your quotation', { exact: true }).setInputFiles(PDF);
  await expect(page.getByRole('list', { name: 'Uploaded file' })).toContainText('quotation.pdf');
  await page.getByLabel('Total of your quotation').pressSequentially('2018180.00');
  await page.getByLabel(/^Your reference/).fill(`E2E-${stamp()}`);
  await fillDateField(page, 'Prices valid until (optional)', '2999-12-31');
  await page.getByLabel(/^Delivery time in days/).fill('14');
  await page.getByRole('button', { name: 'Submit quotation' }).click();
  await expect(page).toHaveURL(new RegExp(`/vendor/rfqs/${rfqId}/quote\\?sent=1$`));
  await expect(
    page.getByRole('status').filter({ hasText: 'We received your quotation' }),
  ).toBeVisible();
});

test('a request that is not this vendor’s is not found, on both pages', async ({ page }) => {
  test.skip(!foreignId, 'PORTAL_E2E_VENDOR_FOREIGN_ID is not set');
  for (const path of [`/vendor/rfqs/${foreignId}`, `/vendor/rfqs/${foreignId}/quote`]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByLabel('Your quotation', { exact: true })).toHaveCount(0);
  }
});

test('a request id that is not an id is not found', async ({ page }) => {
  // Next can already have streamed HTTP 200 before notFound() renders its boundary.
  await page.goto('/vendor/rfqs/not-an-id/quote');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.getByLabel('Your quotation', { exact: true })).toHaveCount(0);
});

test('the quotation file route refuses a foreign Origin without touching the API', async ({
  page,
}) => {
  test.skip(!rfqId, 'PORTAL_E2E_VENDOR_RFQ_ID is not set');
  const res = await page.request.post(`/vendor/rfqs/${rfqId}/quote/file`, {
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/pdf',
      'x-file-name': 'quotation.pdf',
    },
    data: PDF.buffer,
  });
  expect(res.status()).toBe(403);
});

test.describe('a vendor still in onboarding', () => {
  test.skip(
    !pendingState || !rfqId,
    'PORTAL_E2E_PENDING_STATE or PORTAL_E2E_VENDOR_RFQ_ID is not set',
  );
  if (pendingState) test.use({ storageState: pendingState, baseURL: base });

  test('sees the no-access notice instead of the quotation form', async ({ page }) => {
    await page.goto(`/vendor/rfqs/${rfqId}/quote`);
    await expect(
      page.getByRole('heading', { name: 'Your vendor account cannot use this page' }),
    ).toBeVisible();
    await expect(page.getByLabel('Total of your quotation')).toHaveCount(0);
  });
});
