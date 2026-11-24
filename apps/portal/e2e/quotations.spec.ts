import { expect, test } from '@playwright/test';

/**
 * Customer quotations, end to end. Needs a running portal and API with seed data, and a signed-in
 * customer's storage state. The lead runs it; it skips itself when the inputs are missing.
 *
 *   PORTAL_E2E_BASE_URL       e.g. http://localhost:3002
 *   PORTAL_E2E_STORAGE_STATE  path to a storage state of a signed-in customer user
 *   PORTAL_E2E_SENT_ID        a sent, unexpired quotation version of that customer (or a comma-separated list, one per repeat)
 *   PORTAL_E2E_FOREIGN_ID     a quotation version of another customer (or a draft of this one)
 *   PORTAL_E2E_EXPIRED_ID     an expired quotation version of that customer (optional)
 */
const base = process.env.PORTAL_E2E_BASE_URL;
const storageState = process.env.PORTAL_E2E_STORAGE_STATE;
// One id, or a comma-separated list: the accept test uses a quotation up, so each `--repeat-each` run takes the next one.
const sentIds = (process.env.PORTAL_E2E_SENT_ID ?? '').split(',').filter(Boolean);
let sentId: string | undefined;
test.beforeEach(({ browserName: _browser }, info) => {
  sentId = sentIds[info.repeatEachIndex];
});
const foreignId = process.env.PORTAL_E2E_FOREIGN_ID;
const expiredId = process.env.PORTAL_E2E_EXPIRED_ID;

test.skip(!base || !storageState, 'PORTAL_E2E_BASE_URL and PORTAL_E2E_STORAGE_STATE are not set');
if (storageState) test.use({ storageState, baseURL: base });

const FORBIDDEN = /\b(cost|margin|rate|markup)\b/i;

test('lists the customer quotations with number, status, total and valid-until', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Your quotations' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Your quotations' });
  const empty = page.getByRole('heading', { name: 'No quotations yet' });
  await expect(table.or(empty)).toBeVisible();
  if (await table.isVisible()) {
    for (const name of ['Quotation', 'Status', 'Valid until', 'Total']) {
      await expect(table.getByRole('columnheader', { name })).toBeVisible();
    }
  }
});

test('a foreign or draft id and a junk id show the same "Quotation not found"', async ({
  page,
}) => {
  test.skip(!foreignId, 'PORTAL_E2E_FOREIGN_ID is not set');
  for (const id of [foreignId, 'not-an-id']) {
    await page.goto(`/quotations/${id}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Quotation not found' }),
    ).toBeVisible();
  }
  const pdf = await page.request.get(`/quotations/${foreignId}/document`);
  expect(pdf.status()).toBe(404);
  expect(await pdf.text()).toBe('Quotation not found.');
});

test('the quotation page shows no internal word and offers accept and reject', async ({ page }) => {
  test.skip(!sentId, 'PORTAL_E2E_SENT_ID is not set');
  await page.goto(`/quotations/${sentId}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Rev');
  expect(await page.locator('main').innerText()).not.toMatch(FORBIDDEN);
  await expect(page.getByLabel('Your full name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept quotation' })).toBeEnabled();
  await page.getByText('Reject this quotation').click();
  await expect(page.getByLabel('Why are you rejecting it?')).toBeVisible();
});

test('accept asks for the name and the confirmation before it sends', async ({ page }) => {
  test.skip(!sentId, 'PORTAL_E2E_SENT_ID is not set');
  await page.goto(`/quotations/${sentId}`);
  // Native `required` stops an empty submit in the browser; the server checks again.
  await page.getByRole('button', { name: 'Accept quotation' }).click();
  await expect(page).toHaveURL(new RegExp(`/quotations/${sentId}$`));
  await page.getByLabel('Your full name').fill('Jules Winnfield');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Accept quotation' }).click();
  await expect(page).toHaveURL(/responded=accepted/);
  await expect(
    page.getByRole('status').filter({ hasText: 'acceptance is recorded' }),
  ).toBeVisible();
  await expect(page.getByText('You have accepted this quotation.')).toBeVisible();
});

test('an expired quotation shows Accept disabled with the reason', async ({ page }) => {
  test.skip(!expiredId, 'PORTAL_E2E_EXPIRED_ID is not set');
  await page.goto(`/quotations/${expiredId}`);
  const accept = page.getByRole('button', { name: 'Accept quotation' });
  await expect(accept).toBeDisabled();
  await expect(accept).toHaveAccessibleDescription(/expired on/);
});
