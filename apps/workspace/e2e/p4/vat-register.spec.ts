import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

test.skip(process.env.BOS_E2E_P4 !== '1', 'set BOS_E2E_P4=1 to run the P4 VAT register');

async function enterDate(page: Page, label: 'From' | 'To', month: string, day: string) {
  const segments: [string, string][] = [
    ['month', month],
    ['day', day],
    ['year', '2026'],
  ];
  for (const [segment, value] of segments) {
    const field = page.getByRole('spinbutton', {
      name: new RegExp(`${segment}.*${label} \\(AD\\)`, 'i'),
    });
    await field.pressSequentially(value);
  }
}

test('the VAT register validates its date range before offering an export', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  try {
    await signed.page.goto('/payables/vat-register');
    await expect(
      signed.page.getByRole('heading', { level: 1, name: 'Purchase VAT register' }),
    ).toBeVisible();
    await expect(signed.page.getByRole('heading', { name: 'Choose a period.' })).toBeVisible();
    await expect(signed.page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
    await enterDate(signed.page, 'From', '11', '30');
    await enterDate(signed.page, 'To', '11', '01');
    await signed.page.getByRole('button', { name: 'Show register' }).click();
    await expect(signed.page.getByRole('main').getByRole('alert')).toContainText(
      'the end on or after the start',
    );
    await expect(signed.page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  } finally {
    await signed.context.close();
  }
});

test('a valid period shows VAT results and downloads the matching CSV', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  try {
    await signed.page.goto('/payables/vat-register');
    await enterDate(signed.page, 'From', '11', '01');
    await enterDate(signed.page, 'To', '11', '30');
    await signed.page.getByRole('button', { name: 'Show register' }).click();
    await expect(signed.page).toHaveURL(/from=2026-11-01&to=2026-11-30/);
    await expect(
      signed.page.getByRole('heading', { name: 'Purchase VAT', exact: true }),
    ).toBeVisible();
    const exportLink = signed.page.getByRole('link', { name: 'Export CSV' });
    await expect(exportLink).toHaveAttribute(
      'href',
      '/payables/vat-register/export?from=2026-11-01&to=2026-11-30',
    );
    const pendingDownload = signed.page.waitForEvent('download');
    await exportLink.click();
    const download = await pendingDownload;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toMatch(/2026-11-01.*2026-11-30.*\.csv$/);
    const stream = await download.createReadStream();
    if (stream === null) throw new Error('The VAT export download has no content stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    const csv = Buffer.concat(chunks).toString('utf8');
    expect(csv).toContain('"PAN","Vendor","Invoice number","Invoice date (BS)"');
    expect(csv).toContain('"Total"');
  } finally {
    await signed.context.close();
  }
});

test('sales cannot read or export the purchase VAT register', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
  try {
    await signed.page.goto('/payables/vat-register?from=2026-11-01&to=2026-11-30');
    await expect(signed.page.getByRole('main').getByRole('alert')).toContainText(
      'Your roles do not include the purchase VAT register.',
    );
    await expect(signed.page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
    const exportResponse = await signed.page.request.get(
      '/payables/vat-register/export?from=2026-11-01&to=2026-11-30',
    );
    expect(exportResponse.status()).toBe(403);
  } finally {
    await signed.context.close();
  }
});
