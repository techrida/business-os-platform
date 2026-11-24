import { expect, test } from '@playwright/test';

/**
 * Vendor portal, end to end (read screens). Needs a running portal and API with seed data, and a
 * signed-in vendor user's storage state. The lead runs it; it skips itself when the inputs are
 * missing.
 *
 *   PORTAL_E2E_BASE_URL            e.g. http://localhost:3002
 *   PORTAL_E2E_VENDOR_STATE        path to a storage state of a signed-in, approved vendor user
 *   PORTAL_E2E_VENDOR_PO_ID        an issued purchase order of that vendor
 *   PORTAL_E2E_VENDOR_BILL_ID      a bill of that vendor
 *   PORTAL_E2E_VENDOR_FOREIGN_ID   a purchase order id of another vendor (or a draft of this one)
 *   PORTAL_E2E_PENDING_STATE       storage state of a vendor in pending_kyc (optional)
 *   PORTAL_E2E_VENDOR_B_STATE      storage state of a second approved vendor of the same entity (optional)
 */
const base = process.env.PORTAL_E2E_BASE_URL;
const storageState = process.env.PORTAL_E2E_VENDOR_STATE;
const poId = process.env.PORTAL_E2E_VENDOR_PO_ID;
const billId = process.env.PORTAL_E2E_VENDOR_BILL_ID;
const foreignId = process.env.PORTAL_E2E_VENDOR_FOREIGN_ID;
const pendingState = process.env.PORTAL_E2E_PENDING_STATE;
const vendorBState = process.env.PORTAL_E2E_VENDOR_B_STATE;

test.skip(!base || !storageState, 'PORTAL_E2E_BASE_URL and PORTAL_E2E_VENDOR_STATE are not set');
if (storageState) test.use({ storageState, baseURL: base });

// The contract guard's internal words, as whole words. "Under review" is a legitimate status
// label elsewhere, so this checks only what no vendor page should ever show.
const INTERNAL = /\b(score|comparison|variance|ledger|cost centre|budget)\b/i;

test('the vendor home shows the account status and the onboarding checklist', async ({ page }) => {
  await page.goto('/vendor');
  await expect(page.getByRole('heading', { level: 1, name: 'Your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Onboarding checklist' })).toBeVisible();
  await expect(page.getByRole('banner')).toContainText('Vendor portal');
  expect(await page.locator('main').innerText()).not.toMatch(INTERNAL);
});

test('purchase orders list and detail, with the PDF as a plain link', async ({ page }) => {
  await page.goto('/vendor/purchase-orders');
  await expect(page.getByRole('heading', { level: 1, name: 'Your purchase orders' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Your purchase orders' });
  const empty = page.getByRole('heading', { name: 'No purchase orders yet' });
  await expect(table.or(empty)).toBeVisible();

  test.skip(!poId, 'PORTAL_E2E_VENDOR_PO_ID is not set');
  await page.goto(`/vendor/purchase-orders/${poId}`);
  await expect(page.getByRole('table', { name: /^Items on / })).toBeVisible();
  const pdf = page.getByRole('link', { name: 'Download', exact: true });
  if (await pdf.isVisible()) {
    const res = await page.request.get(`/vendor/purchase-orders/${poId}/pdf`);
    expect([200, 409]).toContain(res.status());
  }
  expect(await page.locator('main').innerText()).not.toMatch(INTERNAL);
});

test('bills list and detail show the coarse status and payments', async ({ page }) => {
  await page.goto('/vendor/bills');
  await expect(page.getByRole('heading', { level: 1, name: 'Your bills' })).toBeVisible();
  test.skip(!billId, 'PORTAL_E2E_VENDOR_BILL_ID is not set');
  await page.goto(`/vendor/bills/${billId}`);
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
  expect(await page.locator('main').innerText()).not.toMatch(/balance|outstanding/i);
});

test('a foreign id, a junk id and the PDF of a foreign order all look the same', async ({
  page,
}) => {
  test.skip(!foreignId, 'PORTAL_E2E_VENDOR_FOREIGN_ID is not set');
  for (const id of [foreignId, 'not-an-id']) {
    await page.goto(`/vendor/purchase-orders/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  }
  const pdf = await page.request.get(`/vendor/purchase-orders/${foreignId}/pdf`);
  expect(pdf.status()).toBe(404);
  expect(await pdf.text()).toBe('Purchase order not found.');
});

test.describe('a vendor still in onboarding', () => {
  test.skip(!pendingState, 'PORTAL_E2E_PENDING_STATE is not set');
  if (pendingState) test.use({ storageState: pendingState, baseURL: base });

  test('sees onboarding only, and the orders page shows the no-access notice', async ({ page }) => {
    await page.goto('/vendor');
    const nav = page.getByRole('navigation', { name: 'Vendor portal' });
    await expect(nav.getByRole('link', { name: 'Onboarding' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Purchase orders' })).toHaveCount(0);
    await page.goto('/vendor/purchase-orders');
    await expect(
      page.getByRole('heading', { name: 'Your vendor account cannot use this page' }),
    ).toBeVisible();
  });
});

test.describe('another approved vendor of the same entity', () => {
  test.skip(!vendorBState, 'PORTAL_E2E_VENDOR_B_STATE is not set');
  test.skip(!poId || !billId, 'PORTAL_E2E_VENDOR_PO_ID and PORTAL_E2E_VENDOR_BILL_ID are not set');
  if (vendorBState) test.use({ storageState: vendorBState, baseURL: base });

  test('gets "Page not found" for the order, the bill and the order PDF of the first vendor', async ({
    page,
  }) => {
    await page.goto('/vendor');
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();
    for (const path of [`/vendor/purchase-orders/${poId}`, `/vendor/bills/${billId}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    }
    const pdf = await page.request.get(`/vendor/purchase-orders/${poId}/pdf`);
    expect(pdf.status()).toBe(404);
    expect(await pdf.text()).toBe('Purchase order not found.');
  });
});
