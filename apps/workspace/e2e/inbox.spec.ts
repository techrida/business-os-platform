import { expect, test, type Page } from '@playwright/test';

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
      await test.step('sales submits a memo naming the Founder as its approver', async () => {
        await createDraftMemo(sales.page, {
          title,
          recommenders: [],
          approver: 'Dev Founder',
        });
        const steps = await readPreviewSteps(sales.page);
        await submitMemo(sales.page);
        return steps[0]?.reason ?? '';
      });
    expect(reason.length).toBeGreaterThan(0);

    await test.step('Sales can open the inbox but cannot decide this memo', async () => {
      await sales.page.goto('/inbox');
      await expect(sales.page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
      await expect(sales.page.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
      await expect(inboxRow(sales.page, title)).toHaveCount(0);
    });

    // "Approved by" lists only the people the Memo approver rule allows; for a Sales author that is the Founder.
    const founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);

    await test.step('the named approver sees the reason, and rejecting needs a comment', async () => {
      const page = founder.page;
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

/**
 * The inbox list never scrolls the whole page sideways: the approvals table scrolls inside its own
 * box. It once measured 761px wide in a 390px window and 869px in an 834px one, because the hidden
 * "Actions" header escaped the table's scroll box. A memo for the Founder makes sure the table is
 * on screen (an empty inbox would pass vacuously). The Founder rejects it in `finally`, so a failed
 * width check leaves no pending request behind.
 */
test('the inbox list fits the viewport on a phone and a tablet', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const title = `Inbox width e2e ${new Date().toISOString()}`;
  const opened: Signed[] = [];
  let submitted = false;
  let failed = true;
  let reason = '';
  let founder: Signed | undefined;

  // The Founder rejects the memo. Used by the cleanup below; safe to reach from any point after the submit.
  const rejectMemo = async (page: Page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/inbox');
    // A new request reaches the inbox shortly after the submit; wait for it once.
    await expect(async () => {
      await page.reload();
      await expect(inboxRow(page, title)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await openFromInbox(page, title, reason);
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    const rejection = page.getByRole('dialog', { name: 'Reject request' });
    await rejection
      .getByLabel('Reason for rejection', { exact: true })
      .fill('Rejected by the inbox width spec.');
    await rejection.locator('footer').getByRole('button', { name: 'Reject', exact: true }).click();
    await page.waitForURL(/\/inbox\?decided=reject/, { timeout: 30_000 });
  };

  try {
    const sales = await signInAs(browser, appBase, 'sales');
    opened.push(sales);
    await createDraftMemo(sales.page, { title, recommenders: [], approver: 'Dev Founder' });
    reason = (await readPreviewSteps(sales.page))[0]?.reason ?? '';
    await submitMemo(sales.page);
    submitted = true;

    founder = await signInAs(browser, appBase, 'founder');
    opened.push(founder);
    const page = founder.page;
    await page.goto('/inbox');
    await expect(async () => {
      await page.reload();
      await expect(inboxRow(page, title)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    for (const size of [
      { width: 834, height: 1194 },
      { width: 390, height: 844 },
    ]) {
      await test.step(`the inbox fits ${size.width}px`, async () => {
        await page.setViewportSize(size);
        await page.goto('/inbox');
        await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: /^Waiting approvals/ })).toBeVisible();
        const fits = () =>
          page.evaluate(() => {
            const el = document.scrollingElement ?? document.documentElement;
            return el.scrollWidth <= el.clientWidth;
          });
        await expect.poll(fits).toBe(true);
      });
    }
    failed = false;
  } finally {
    try {
      if (submitted) {
        // A cleanup failure is reported on its own and never replaces the failure that got us here.
        await test
          .step('the Founder rejects the memo so nothing is left pending', async () => {
            const signed = founder ?? (await signInAs(browser, appBase, 'founder'));
            if (founder === undefined) opened.push(signed);
            await rejectMemo(signed.page);
          })
          .catch((error: unknown) => {
            if (failed) console.error('inbox width spec: cleanup also failed:', error);
            else throw error;
          });
      }
    } finally {
      await Promise.all(opened.map((signed) => signed.context.close()));
    }
  }
});
