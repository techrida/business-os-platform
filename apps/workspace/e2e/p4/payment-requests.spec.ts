import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';
import {
  expectParam,
  expectSelected,
  multiSelectByLabel,
  toggleOptions,
} from '../helpers/multi-select';
import { optionLabels, selectByLabel } from '../helpers/select';

test.skip(process.env.BOS_E2E_P4 !== '1', 'set BOS_E2E_P4=1 to run P4 payment requests');

test('payment requests load and filter by status', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  try {
    await signed.page.goto('/payables/payment-requests');
    await expect(
      signed.page.getByRole('heading', { level: 1, name: 'Payment requests' }),
    ).toBeVisible();
    // Filters apply as they change: no Show button, the URL is the state.
    const status = multiSelectByLabel(signed.page, 'Status');
    await toggleOptions(status, ['draft']);
    await expectParam(signed.page, 'status', ['draft']);
    await expectSelected(status, ['draft']);
    await expect(signed.page.getByRole('link', { name: 'New payment request' })).toBeVisible();
  } finally {
    await signed.context.close();
  }
});

test('new requests offer eligible bills or explain that none are available', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  try {
    await signed.page.goto('/payables/payment-requests/new');
    await expect(
      signed.page.getByRole('heading', { level: 1, name: 'New payment request' }),
    ).toBeVisible();
    // The vendor field is a search box (a combobox), not a list.
    const vendor = signed.page.getByRole('combobox', { name: 'Vendor', exact: true });
    const empty = signed.page.getByText(
      'No approved bill balances are available for a payment request.',
      { exact: false },
    );
    await expect(vendor.or(empty)).toBeVisible();
    if (await vendor.isVisible()) {
      // Review request opens the review dialog, whose button creates the draft: nothing is created from this page.
      await expect(signed.page.getByRole('button', { name: 'Review request' })).toBeVisible();
      await expect(selectByLabel(signed.page, 'Bill 1')).toBeDisabled();
      await vendor.click();
      await signed.page.getByRole('option').first().click();
      await expect(selectByLabel(signed.page, 'Bill 1')).toBeEnabled();
      // More than the "Choose an approved bill" option alone.
      await expect
        .poll(async () => (await optionLabels(selectByLabel(signed.page, 'Bill 1'))).length)
        .toBeGreaterThan(1);
      await signed.page.getByRole('button', { name: 'Add a payable item' }).click();
      await expect(selectByLabel(signed.page, 'Bill 2')).toBeVisible();
      await signed.page.getByRole('button', { name: 'Remove item 2' }).click();
      await expect(selectByLabel(signed.page, 'Bill 2')).toHaveCount(0);
    }
  } finally {
    await signed.context.close();
  }
});

test('sales cannot open payment request entry', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
  try {
    await signed.page.goto('/payables/payment-requests/new');
    await expect(signed.page.getByRole('main').getByRole('alert')).toContainText(
      'Your roles do not include payment requests.',
    );
    await expect(signed.page.getByRole('button', { name: 'Create draft request' })).toHaveCount(0);
  } finally {
    await signed.context.close();
  }
});

test('a seeded draft exposes its items, bank snapshot and approval dialog', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const id = process.env.BOS_E2E_DRAFT_PAYMENT_REQUEST_ID;
  test.skip(!id, 'set BOS_E2E_DRAFT_PAYMENT_REQUEST_ID to an existing draft request');
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'founder');
  try {
    await signed.page.goto(`/payables/payment-requests/${id}`);
    await expect(
      signed.page.getByRole('heading', { name: 'Payable items', exact: true }),
    ).toBeVisible();
    await expect(
      signed.page.getByText('Verified vendor account snapshot', { exact: true }),
    ).toBeVisible();
    await signed.page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
    const dialog = signed.page.getByRole('dialog', { name: 'Submit for approval', exact: true });
    await expect(dialog).toContainText('Approval does not send money.');
    await signed.page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  } finally {
    await signed.context.close();
  }
});
