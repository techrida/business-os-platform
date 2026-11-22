import { expect, test } from '@playwright/test';

import { signInAs, type Signed } from '../helpers/memo-flow';
import {
  clearSelection,
  expectParam,
  expectSelected,
  multiSelectByLabel,
  toggleOptions,
} from '../helpers/multi-select';
import { minimalPdf } from '../helpers/pdf-fixture';
import { chooseOption, selectByLabel } from '../helpers/select';

/**
 * The P3 payments screens (list and detail), against the real stack. Not run by the unit that wrote
 * it: it needs the `/v1/payments` routes (U7), the payment permission grants, and the nav entry the
 * lead adds. Written for the lead to run once those exist.
 *
 * (1) Finance opens the list; the status filter keeps its choice in the URL and an empty filter
 *     says so in words.
 * (2) A payment id that does not exist shows "Payment not found", not a blank page.
 * (3) A payment the signed-in person recorded cannot be verified by them: the refusal is shown in
 *     the dialog in plain words. Creates a disposable Finance-recorded payment with a scanned PDF proof.
 */

test('the payments list loads and its status filter keeps the choice', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);

    await test.step('the list shows a table or an empty state', async () => {
      await finance.page.goto('/payments');
      await expect(finance.page.getByRole('heading', { level: 1, name: 'Payments' })).toBeVisible();
      await expect(
        finance.page
          .getByRole('region', { name: /Payments/ })
          .or(finance.page.getByText('No payments yet.'))
          .or(finance.page.getByRole('alert').filter({ hasText: /\S/ })),
      ).toBeVisible();
    });

    await test.step('filtering by status updates the URL at once and the select', async () => {
      // No Apply button: each change is written to the URL as a repeated param.
      const status = multiSelectByLabel(finance.page, 'Status');
      await toggleOptions(status, ['rejected']);
      await expectParam(finance.page, 'status', ['rejected']);
      await expectSelected(status, ['rejected']);
      await expect(
        finance.page
          .getByRole('region', { name: /Payments/ })
          .or(finance.page.getByText('No payments match these filters.')),
      ).toBeVisible();
      await toggleOptions(status, ['verified']);
      await expectParam(finance.page, 'status', ['rejected', 'verified']);
      await expect(status).toContainText('2 statuses');
      await clearSelection(status);
      await expectParam(finance.page, 'status', []);
      await expectSelected(status, []);
    });

    await test.step('repeated params in the URL select several values', async () => {
      await finance.page.goto('/payments?status=verified&status=rejected');
      const status = multiSelectByLabel(finance.page, 'Status');
      await expectSelected(status, ['verified', 'rejected']);
      await expect(status).toContainText('2 statuses');
    });

    await test.step('a hand-edited filter is ignored, not sent to the API', async () => {
      await finance.page.goto('/payments?status=bogus');
      await expectSelected(multiSelectByLabel(finance.page, 'Status'), []);
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('an unknown payment shows words, not a blank page', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];

  try {
    const finance = await signInAs(browser, appBase, 'founder');
    opened.push(finance);

    await finance.page.goto('/payments/00000000-0000-4000-8000-000000000000');
    await expect(
      finance.page.getByRole('alert').filter({ hasText: /Payment not found|did not load/ }),
    ).toBeVisible();
    await finance.page.goto('/payments/not-an-id');
    await expect(finance.page.getByText('That is not a payment')).toBeVisible();
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});

test('the person who recorded a payment cannot verify it', async ({ browser, baseURL }) => {
  const customer = process.env['BOS_E2E_PAYMENT_CUSTOMER'];
  test.skip(!customer, 'needs a disposable customer for a Finance-recorded payment');
  test.setTimeout(180_000);
  const finance = await signInAs(browser, baseURL ?? 'https://app.localhost', 'finance');
  try {
    const page = finance.page;
    await page.goto('/payments/new');
    await chooseOption(selectByLabel(page, 'Customer'), { label: customer ?? '' });
    await page.getByLabel('Amount received').fill('2.00');
    await page.getByLabel('Bank reference').fill('E2E-self-verification-' + Date.now());
    await page.getByLabel('Add proof files').setInputFiles({
      name: 'self-verification.pdf',
      mimeType: 'application/pdf',
      buffer: minimalPdf('Self verification refusal fixture'),
    });
    await expect(
      page.getByRole('list', { name: 'Uploaded proof' }).getByText('self-verification.pdf'),
    ).toBeVisible({ timeout: 60_000 });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await page.getByRole('button', { name: 'Record payment', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
      if (
        await page
          .waitForURL(/\/payments\/[0-9a-f-]{36}$/, { timeout: 10_000 })
          .then(() => true)
          .catch(() => false)
      )
        break;
      await expect(page.getByText(/A proof file is not ready yet/)).toBeVisible();
      await page.waitForTimeout(5_000);
    }
    await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
    await page.getByRole('button', { name: 'self-verification.pdf', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'self-verification.pdf' });
    await expect(preview.getByRole('link', { name: 'Download' })).toBeVisible();
    if (await page.evaluate(() => navigator.pdfViewerEnabled !== false)) {
      await expect(preview.getByTitle('Preview of self-verification.pdf')).toHaveAttribute(
        'src',
        /\/preview[#?]/,
      );
    } else {
      await expect(preview.getByText('No preview')).toBeVisible();
    }
    await preview.getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.getByRole('button', { name: 'Verify payment', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Verify this payment', exact: true });
    await dialog.getByRole('button', { name: 'Verify payment', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'You recorded this payment, so someone else in Finance must verify it',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Awaiting verification', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toContainText('RCPT-');
  } finally {
    await finance.context.close();
  }
});
