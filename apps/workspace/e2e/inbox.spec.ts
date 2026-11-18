import { expect, test } from '@playwright/test';

import {
  createDraftMemo,
  inboxRow,
  openFromInbox,
  readPreviewSteps,
  signInAs,
  submitMemo,
  type Signed,
} from './helpers/memo-flow';

/**
 * The inbox screen on its own, against the real stack: (1) an approver's inbox row shows WHY the
 * item is theirs, the same reason the route preview gave (for an internal memo, the person the author selected); (2) the Sales inbox excludes this memo; (3) rejecting needs a comment, and
 * a rejected item leaves the inbox. It rejects at the end so it leaves no pending request behind.
 * The full two-approval story is in exit.spec.ts.
 */

test('the inbox shows the reason for each item, and excludes the requester’s memo', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const title = `Inbox e2e ${new Date().toISOString()}`;
  const opened: Signed[] = [];

  try {
    const sales = await signInAs(browser, appBase, 'sales');
    opened.push(sales);

    const reason =
      await test.step('sales submits a memo naming Management as its approver', async () => {
        await createDraftMemo(sales.page, {
          title,
          recommenders: [],
          approver: 'Dev Management',
        });
        const steps = await readPreviewSteps(sales.page);
        await submitMemo(sales.page);
        return steps[0]?.reason ?? '';
      });
    expect(reason.length).toBeGreaterThan(0);

    await test.step('Sales can open the inbox but cannot decide this memo', async () => {
      await sales.page.goto('/inbox');
      await expect(sales.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
      await expect(sales.page.getByRole('alert')).toHaveCount(0);
      await expect(inboxRow(sales.page, title)).toHaveCount(0);
    });

    const management = await signInAs(browser, appBase, 'management');
    opened.push(management);

    await test.step('the named approver sees the reason, and rejecting needs a comment', async () => {
      const page = management.page;
      await openFromInbox(page, title, reason);
      await expect(page.getByRole('region', { name: 'Attachments', exact: true })).toHaveCount(0);

      const rejectButton = page.getByRole('button', { name: 'Reject', exact: true });
      const rejection = page.getByRole('dialog', { name: 'Reject request' });
      const reject = rejection
        .locator('footer')
        .getByRole('button', { name: 'Reject', exact: true });
      await rejectButton.click();
      await rejection.getByRole('button', { name: 'Cancel' }).click();
      await expect(rejection).toHaveCount(0);
      await expect(rejectButton).toBeFocused();

      // Reject without a comment: refused in place, with the field named.
      await rejectButton.click();
      await reject.click();
      await expect(
        rejection.getByText('Say why you are rejecting it. The reason is kept in the audit trail.'),
      ).toBeVisible();
      await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);

      await rejection
        .getByLabel('Reason for rejection', { exact: true })
        .fill('Rejected by the inbox spec.');
      await reject.click();
      await page.waitForURL(/\/inbox\?decided=reject/, { timeout: 30_000 });
      await expect(page.getByText('The request was rejected.')).toBeVisible();
      await expect(inboxRow(page, title)).toHaveCount(0);
    });
  } finally {
    await Promise.all(opened.map((signed) => signed.context.close()));
  }
});
