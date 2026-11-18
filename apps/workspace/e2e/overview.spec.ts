import { expect, test } from '@playwright/test';

import { createDraftMemo, signInAs, submitMemo } from './helpers/memo-flow';

test('overview shows an assigned approval to the approver and excludes it for the requester', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const app = baseURL ?? 'https://app.localhost';
  const subject = `Overview e2e ${new Date().toISOString()}`;
  const sales = await signInAs(browser, app, 'sales');
  try {
    await createDraftMemo(sales.page, {
      title: subject,
      recommenders: [],
      approver: 'Dev Accountant',
    });
    const approvalId = await submitMemo(sales.page);
    await sales.page.goto('/');
    await expect(sales.page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(
      sales.page
        .getByRole('table', { name: 'Pending approvals' })
        .getByRole('link', { name: subject }),
    ).toHaveCount(0);
    await expect(sales.page.getByText('Unread notifications', { exact: true })).toBeVisible();

    const accountant = await signInAs(browser, app, 'accountant');
    try {
      const page = accountant.page;
      const row = page
        .getByRole('table', { name: 'Pending approvals' })
        .getByRole('link', { name: subject });
      await expect(row).toHaveAttribute('href', `/inbox/${approvalId}`);
      await expect(page.getByText(/approvals? to review/)).toBeVisible();
      await row.click();
      await expect(page).toHaveURL(new RegExp(`/inbox/${approvalId}$`));
      await expect(page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
    } finally {
      await accountant.context.close();
    }
  } finally {
    await sales.context.close();
  }
});
