import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

/**
 * Warm-up step of the qa workflow ("qa fixtures": the specs skip it). The KYB queue spec (p2/customers.spec) opens a
 * case that is waiting for review and skips when the queue is empty. Sales creates a fictional customer, starts its
 * verification, uploads the three required documents and submits the case, the way a salesperson would, and leaves it
 * waiting for the reviewer. The reviewer specs that decide cases make their own customers.
 */
const labels = [
  'Company registration certificate',
  'PAN or VAT certificate',
  'Authorised signatory ID',
];
// A one-pixel PNG: the scan and the preview accept it, and it holds no real document.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwazkIAAJvAXxaFZv2AAAAAElFTkSuQmCC',
  'base64',
);

const row = (page: Page, label: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });

async function upload(page: Page, label: string, name: string): Promise<void> {
  const fileRow = row(page, label);
  const choose = page.waitForEvent('filechooser');
  await fileRow.getByRole('button', { name: `Upload ${label}` }).click();
  await (await choose).setFiles({ name, mimeType: 'image/png', buffer: PNG });
  const preview = page.getByRole('dialog', { name });
  await expect(preview.getByRole('img', { name })).toBeVisible({ timeout: 60_000 });
  await preview.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(fileRow.getByText('Pending', { exact: true })).toBeVisible();
}

test('qa fixtures: a customer verification case waits for review', async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const { context, page } = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
  try {
    await page.goto('/customers/new');
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Organization legal name').fill(`QA fixture review ${Date.now()}`);
    await page.getByLabel('Address', { exact: true }).fill('Fixture road');
    await page.getByLabel('City', { exact: true }).fill('Kathmandu');
    await page.getByLabel('Full name').fill('Fixture Contact');
    await page.getByLabel('Email', { exact: true }).fill('fixture.review@example.test');
    await page.getByRole('button', { name: 'Create Organization', exact: true }).click();
    await page.getByRole('button', { name: 'Start verification' }).click();
    await expect(page).toHaveURL(/\/verification\/[0-9a-f-]{36}$/);
    for (const [index, label] of labels.entries()) {
      await upload(page, label, `qa-fixture-${index}.png`);
    }
    await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Submit for review', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Submit for review', exact: true })).toHaveCount(
      0,
    );
  } finally {
    await context.close();
  }
});
