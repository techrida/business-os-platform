import { expect, test } from '@playwright/test';

import { createDraftMemo, minimalPdf, signInAs, submitMemo } from './helpers/memo-flow';

test('immediate picker/drop upload, removal recovery and submitted attachment lock', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const signed = await signInAs(browser, baseURL!, 'sales');
  const page = signed.page;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await createDraftMemo(page, {
      title: `Attachment recovery ${Date.now()}`,
      amount: '50000',
    });
    const origin = new URL(baseURL!).origin;
    const rows = page.getByRole('list', { name: 'Attachments' }).getByRole('listitem');
    const row = (name: string) => rows.filter({ hasText: name });
    const upload = page.getByRole('button', { name: 'Upload file', exact: true });

    // Selecting through the actual button's file chooser starts upload: no second click.
    for (let index = 0; index < 2; index++) {
      const chooser = page.waitForEvent('filechooser');
      await upload.click();
      await (
        await chooser
      ).setFiles({
        name: 'repeat.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('Repeated file picker selection'),
      });
      await expect(row('repeat.pdf')).toHaveCount(index + 1, { timeout: 30_000 });
      await expect(upload).toBeEnabled();
    }
    await expect(row('repeat.pdf').first()).toContainText('Scan passed', { timeout: 60_000 });
    await expect(row('repeat.pdf').last()).toContainText('Scan passed', { timeout: 60_000 });

    // Server refusal must not optimistically hide a file.
    const deleteRoute = '**/api/documents/*';
    await page.route(deleteRoute, (route) =>
      route.fulfill({ status: 403, json: { error: { message: 'Removal refused for test.' } } }),
    );
    await page.getByRole('button', { name: 'Remove repeat.pdf', exact: true }).first().click();
    await expect(page.getByText('Removal refused for test.')).toBeVisible();
    await expect(row('repeat.pdf')).toHaveCount(2);
    await page.unroute(deleteRoute);
    for (let remaining = 1; remaining >= 0; remaining--) {
      await page.getByRole('button', { name: 'Remove repeat.pdf', exact: true }).first().click();
      await expect(row('repeat.pdf')).toHaveCount(remaining);
    }
    await expect(upload).toBeFocused();

    const dropzone = page
      .locator('div')
      .filter({ has: upload })
      .filter({
        has: page.getByText('Or drag and drop a single file here.', { exact: true }),
      })
      .last();
    // Harmless standard antivirus test string, never executable malware.
    const antivirusTest = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
    const transfer = await page.evaluateHandle((content) => {
      const data = new DataTransfer();
      data.items.add(new File([content], 'blocked.csv', { type: 'text/csv' }));
      return data;
    }, antivirusTest);
    await dropzone.dispatchEvent('drop', { dataTransfer: transfer });
    await transfer.dispose();
    await expect(row('blocked.csv')).toContainText('Virus found', { timeout: 60_000 });
    await expect(page.getByRole('link', { name: 'Download blocked.csv' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Submit for approval', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Remove blocked.csv', exact: true }).click();
    await expect(row('blocked.csv')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Submit for approval', exact: true }),
    ).toBeEnabled();

    // Keep a real clean file to prove the post-submit API lock too.
    const response = page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/memos\/[^/]+\/attachments$/.test(r.url()),
    );
    const chooser = page.waitForEvent('filechooser');
    await upload.click();
    await (
      await chooser
    ).setFiles({ name: 'locked.pdf', mimeType: 'application/pdf', buffer: minimalPdf('Frozen') });
    const { item } = (await (await response).json()) as { item: { documentId: string } };
    await expect(row('locked.pdf')).toContainText('Scan passed', { timeout: 60_000 });

    for (const headers of [{}, { Origin: 'https://foreign.invalid' }]) {
      const refused = await signed.context.request.delete(`/api/documents/${item.documentId}`, {
        headers,
      });
      expect(refused.status()).toBe(403);
    }
    await submitMemo(page);
    await expect(upload).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove locked.pdf' })).toHaveCount(0);
    const refused = await signed.context.request.delete(`/api/documents/${item.documentId}`, {
      headers: { Origin: origin },
    });
    expect(refused.status()).toBe(409);
    await page.reload();
    await expect(row('locked.pdf')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors.filter((error) => /hydration/i.test(error))).toEqual([]);
  } finally {
    await signed.context.close();
  }
});
