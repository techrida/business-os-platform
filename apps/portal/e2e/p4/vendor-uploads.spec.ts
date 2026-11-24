import { expect, test } from '@playwright/test';

import { minimalPdf } from '../../../workspace/e2e/helpers/pdf-fixture';
import { fillDateField } from '../helpers/date-fields';

/**
 * Vendor portal uploads, end to end: a KYC document, a bill, and a bank-account change request.
 * Needs a running portal and API with seed data and a signed-in vendor user's storage state. The
 * lead runs it; it skips itself when the inputs are missing. Each run writes real rows (an inbox
 * bill, a proposed bank account, a KYC document in review), so point it at a throwaway tenant.
 *
 *   PORTAL_E2E_BASE_URL         e.g. http://localhost:3002
 *   PORTAL_E2E_VENDOR_STATE     storage state of a signed-in, approved vendor user
 *   PORTAL_E2E_PENDING_STATE    storage state of a pending_kyc vendor with an editable KYB case
 *                             and a pan_certificate checklist item (optional; KYC writes need it)
 */
const base = process.env.PORTAL_E2E_BASE_URL;
const storageState = process.env.PORTAL_E2E_VENDOR_STATE;
const pendingState = process.env.PORTAL_E2E_PENDING_STATE;

test.skip(!base || !storageState, 'PORTAL_E2E_BASE_URL and PORTAL_E2E_VENDOR_STATE are not set');
if (storageState) test.use({ storageState, baseURL: base });

const PDF = {
  name: 'scan.pdf',
  mimeType: 'application/pdf',
  buffer: minimalPdf('P4 portal upload'),
};
const stamp = () => Date.now().toString(36).toUpperCase();

test('refuses a KYC submit without a file, naming the field', async ({ page }) => {
  await page.goto('/vendor/onboarding/upload');
  await page.getByRole('button', { name: 'Send document' }).click();
  await expect(page.getByText('Add the document as a PDF or a picture.')).toBeVisible();
});

test('a file that is not a PDF or a picture is refused in the browser, before any upload', async ({
  page,
}) => {
  await page.goto('/vendor/bills/new');
  await page.waitForLoadState('networkidle');
  let uploaded = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/vendor/bills/new/file')
      uploaded = true;
  });
  await page
    .getByLabel('Your bill')
    .setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await expect(
    page.getByRole('alert').filter({ hasText: 'is not a PDF or a picture' }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Uploaded file' })).toHaveCount(0);
  expect(uploaded, 'an unsupported file never reaches the upload route').toBe(false);
});

test('submits a bill: the total is the vendor’s own text, and the answer says what happens next', async ({
  page,
}) => {
  await page.goto('/vendor/bills/new');
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { level: 1, name: 'Submit a bill' })).toBeVisible();
  await page.getByLabel('Your bill').setInputFiles(PDF);
  await expect(page.getByRole('list', { name: 'Uploaded file' })).toContainText('scan.pdf');
  await page.getByLabel('Your invoice number').fill(`E2E-${stamp()}`);
  await fillDateField(page, 'Invoice date', '2026-11-01');
  await page.getByLabel('Total on your invoice').pressSequentially('2018180.00');
  await page.getByRole('button', { name: 'Submit bill' }).click();
  const done = page.getByRole('status').filter({ hasText: 'We received your bill' });
  await expect(done).toBeVisible();
  await expect(done).toContainText('once we have entered it');
});

test('a bill with a bad total names the field and keeps what was typed', async ({ page }) => {
  await page.goto('/vendor/bills/new');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Your bill').setInputFiles(PDF);
  await expect(page.getByRole('list', { name: 'Uploaded file' })).toBeVisible();
  await page.getByLabel('Your invoice number').fill('E2E-BAD');
  await fillDateField(page, 'Invoice date', '2026-11-01');
  await page.getByLabel('Total on your invoice').fill('twelve');
  await page.getByRole('button', { name: 'Submit bill' }).click();
  await expect(page.getByText(/Enter the total on your invoice/)).toBeVisible();
  await expect(page.getByLabel('Your invoice number')).toHaveValue('E2E-BAD');
});

test('requests a bank-account change and never shows the number back', async ({ page }) => {
  const number = `90${Date.now().toString().slice(-10)}`;
  await page.goto('/vendor/bank-account');
  await expect(page.getByRole('heading', { level: 1, name: 'Bank account' })).toBeVisible();
  await page.getByLabel('Bank name').fill('E2E Bank');
  await page.getByLabel('Account name', { exact: true }).fill('E2E Traders Pvt Ltd');
  await page.getByLabel('Account number', { exact: true }).fill(number);
  await page.getByLabel('Account number again').fill(number);
  await page.getByRole('button', { name: 'Request change' }).click();
  const done = page.getByRole('status').filter({ hasText: 'We received your request' });
  await expect(done).toBeVisible();
  await expect(done).toContainText(`ending ${number.slice(-4)}`);
  // The page, the fields and the URL hold no full number after the answer.
  expect(await page.locator('main').innerText()).not.toContain(number);
  await expect(page.getByLabel('Account number', { exact: true })).toHaveValue('');
  expect(page.url()).not.toContain(number);
});

test('two different account numbers are caught before anything is sent', async ({ page }) => {
  await page.goto('/vendor/bank-account');
  await page.getByLabel('Bank name').fill('E2E Bank');
  await page.getByLabel('Account name', { exact: true }).fill('E2E Traders Pvt Ltd');
  await page.getByLabel('Account number', { exact: true }).fill('1234567890');
  await page.getByLabel('Account number again').fill('1234567891');
  await page.getByRole('button', { name: 'Request change' }).click();
  await expect(page.getByText('The two account numbers are not the same.')).toBeVisible();
});

test('the upload routes refuse a foreign Origin without touching the API', async ({ page }) => {
  for (const path of ['/vendor/bills/new/file', '/vendor/onboarding/upload/file']) {
    const res = await page.request.post(path, {
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/pdf',
        'x-file-name': 'scan.pdf',
      },
      data: PDF.buffer,
    });
    expect(res.status()).toBe(403);
  }
});

test.describe('a vendor still in onboarding', () => {
  test.skip(
    !pendingState,
    'set PORTAL_E2E_PENDING_STATE for a pending_kyc vendor with an editable KYB case and pan_certificate checklist item',
  );
  if (pendingState) test.use({ storageState: pendingState, baseURL: base });

  test('sends a KYC document from an editable case and sees the confirmation', async ({ page }) => {
    await page.goto('/vendor/onboarding/upload');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { level: 1, name: 'Send a document' })).toBeVisible();
    // The shared Select: open its trigger (the button beside the hidden docType field), pick by label.
    await page.locator('input[name="docType"]').locator('..').getByRole('button').click();
    await page.getByRole('option', { name: /^PAN certificate/ }).click();
    await expect(page.locator('input[name="docType"]')).toHaveValue('pan_certificate');
    await page.getByLabel('File', { exact: true }).setInputFiles(PDF);
    await expect(page.getByRole('list', { name: 'Uploaded file' })).toContainText('scan.pdf');
    await page.getByRole('button', { name: 'Send document' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'We received your document' }),
    ).toBeVisible();
  });

  test('can send KYC documents, but bills and bank changes show the no-access notice', async ({
    page,
  }) => {
    await page.goto('/vendor/onboarding/upload');
    await expect(page.getByRole('heading', { level: 1, name: 'Send a document' })).toBeVisible();
    for (const path of ['/vendor/bills/new', '/vendor/bank-account']) {
      await page.goto(path);
      await expect(
        page.getByRole('heading', { name: 'Your vendor account cannot use this page' }),
      ).toBeVisible();
    }
  });
});
