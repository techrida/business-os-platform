import { expect, test, type Page } from '@playwright/test';

import { statusWithoutToken } from './helpers/api';
import {
  createDraftMemo,
  inboxRow,
  openFromInbox,
  readPreviewSteps,
  signInAs,
  submitMemo,
  type Signed,
} from './helpers/memo-flow';
import { sentTo, waitForMessage } from './helpers/mailpit';
import { persona } from './helpers/personas';

/**
 * THE MEMO EXIT TEST, full stack. An internal memo goes through the approval route its author named, with no
 * self-approval, an email and a full audit trail. (Phase 1 ran this story on a memo with an amount and a scanned
 * upload; from P2 a memo is correspondence: no amount, no files, and no financial threshold. The upload and scan
 * path is covered at the API layer in apps/api/test/e2e.) Nothing is faked: real ZITADEL with a TOTP second
 * factor, real Mailpit, the real API and worker, and the real Workspace, driven only through the browser's
 * accessible controls.
 *
 * What it proves, in order (one test, one `test.step` each, separate browser contexts per persona):
 *  1. Sales signs in with password + TOTP and saves a memo that names Management as the recommender and the
 *     Founder as the approver ("Approved by" lists only the people the Memo approver rule allows: the Sales
 *     department head cannot decide approvals, so the rule falls back to the Founder role).
 *  2. Before submitting, the route preview shows exactly those two people in that order, each with a reason.
 *     Sales submits, and the memo becomes "Submitted".
 *  3. No self-approval: the Sales inbox excludes the memo, and the
 *     request's own page (opened by URL) offers Sales no Approve button.
 *  4. Management signs in, sees the memo in the inbox with the same reason the preview gave, and approves
 *     (banner "Your approval was recorded.").
 *  5. The Founder signs in, sees it (step 2 is now active), and approves. The memo page shows "Approved".
 *  6. Mailpit holds the "Approval needed" email to Management and to the Founder, and the decided email to
 *     Sales.
 *  7. Finance's Audit timeline on the memo page lists the memo being created and changed, the submit, and two
 *     approvals; Sales (no audit permission) is told the trail is hidden.
 *
 * What it does NOT prove: the audit hash chain (`GET /v1/audit/verify`). That route needs a
 * bearer token and the Workspace never exposes one to the browser, and there is no Workspace
 * route that calls it, so the spec only checks (softly) that the route refuses an anonymous call.
 * `approvals.e2e.test.ts` verifies the chain at the API layer.
 *
 * Requires: `pnpm seed` (personas with TOTP), the API and worker running with SMTP pointed at
 * Mailpit, and BASE_URL or the default https://app.localhost.
 */

// Mail goes through BullMQ: allow a generous wait.
const MAIL_TIMEOUT_MS = 60_000;

/** Approves from an inbox detail page and checks the confirmation toast on the inbox. */
async function approve(page: Page, comment: string): Promise<void> {
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve request' });
  await dialog.getByPlaceholder('Anything the requester should know').fill(comment);
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForURL(/\/inbox\?decided=approve/, { timeout: 30_000 });
  await expect(page.getByText('Your approval was recorded.')).toBeVisible();
}

test('memo exit: a memo goes through the two approvals its author named, with emails and an audit trail', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const title = `Exit e2e ${new Date().toISOString()}`;
  const opened: Signed[] = [];
  const signIn = async (key: string): Promise<Page> => {
    const signed = await signInAs(browser, appBase, key);
    opened.push(signed);
    return signed.page;
  };

  try {
    // ---------------------------------------------------------------- 1. sales creates the memo
    const sales = await signIn('sales');
    const { memoId, memoNumber } =
      await test.step('sales saves a memo naming two signers', async () => {
        // Management recommends, the Founder approves: neither order nor people come from an amount.
        return createDraftMemo(sales, {
          title,
          recommenders: ['Dev Management'],
          approver: 'Dev Founder',
        });
      });

    // ------------------------------------------------------ 2. preview, then submit for approval
    const preview =
      await test.step('the preview shows the two selected people in order, then sales submits', async () => {
        const steps = await readPreviewSteps(sales);
        expect(steps, 'one step per named signer').toHaveLength(2);
        expect(steps[0]?.who).toContain('Dev Management');
        expect(steps[1]?.who).toContain('Dev Founder');
        return steps;
      });
    const stepOneReason = preview[0]?.reason ?? '';
    const stepTwoReason = preview[1]?.reason ?? '';

    const requestId = await test.step('sales submits', async () => {
      const id = await submitMemo(sales);
      await expect(sales.getByText('Submitted', { exact: true })).toBeVisible();
      await expect(sales.getByRole('region', { name: 'Edit memo', exact: true })).toHaveCount(0);
      return id;
    });

    // ------------------------------------------------------------------ 3. no self-approval
    await test.step('sales cannot approve their own memo: inbox says so, and the request has no Approve button', async () => {
      await sales.goto('/inbox');
      await expect(sales.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
      await expect(sales.getByRole('alert').filter({ hasText: /\S/ })).toHaveCount(0);
      await expect(inboxRow(sales, title)).toHaveCount(0);

      // The request itself may be read by its requester (approvals.requests.read, own scope), but
      // the page offers no decision.
      await sales.goto(`/inbox/${requestId}`);
      await expect(
        sales.getByText('This request is waiting for a different approver.'),
      ).toBeVisible();
      await expect(sales.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(sales.getByRole('button', { name: 'Reject' })).toHaveCount(0);
    });

    // ------------------------------------------------------------------ 4. management approves
    const management = await signIn('management');
    await test.step('the named recommender sees the reason in the inbox and approves step 1', async () => {
      const found = await openFromInbox(management, title, stepOneReason);
      expect(found.requestId).toBe(requestId);
      await approve(management, 'Looks right. Step 1 approved by the exit spec.');
      // Decided: it leaves this person's inbox.
      await expect(inboxRow(management, title)).toHaveCount(0);
    });

    // ------------------------------------------------------------------------ 5. founder approves
    const founder = await signIn('founder');
    await test.step('the named approver sees step 2 and approves; the memo is approved', async () => {
      const found = await openFromInbox(founder, title, stepTwoReason);
      expect(found.requestId).toBe(requestId);
      await approve(founder, 'Agreed. Step 2 approved by the exit spec.');

      // The memo status follows the request's decision; allow a moment, then reload to read it.
      await founder.goto(`/memos/${memoId}`);
      await expect(async () => {
        await founder.reload();
        await expect(founder.getByText('Approved', { exact: true }).first()).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 30_000 });
      await expect(founder.getByText('This memo was approved.')).toBeVisible();
    });

    // -------------------------------------------------------------------------- 6. the emails
    await test.step('Mailpit holds the pending emails and the decided email', async () => {
      const forThisMemo = (subject: string): boolean => subject.includes(memoNumber);
      const managementEmail = persona('management').username;
      const founderEmail = persona('founder').username;
      const salesEmail = persona('sales').username;

      // approval.pending: "Approval needed: <type> <number>", one per step as it activates.
      await waitForMessage(
        (m) =>
          forThisMemo(m.Subject) &&
          m.Subject.startsWith('Approval needed') &&
          sentTo(m, managementEmail),
        `the "Approval needed" email to ${managementEmail} for ${memoNumber}`,
        MAIL_TIMEOUT_MS,
      );
      await waitForMessage(
        (m) =>
          forThisMemo(m.Subject) &&
          m.Subject.startsWith('Approval needed') &&
          sentTo(m, founderEmail),
        `the "Approval needed" email to ${founderEmail} for ${memoNumber}`,
        MAIL_TIMEOUT_MS,
      );
      // approval.decided goes to the requester: "<type> <number>: <decision>".
      const decided = await waitForMessage(
        (m) =>
          forThisMemo(m.Subject) &&
          !m.Subject.startsWith('Approval needed') &&
          sentTo(m, salesEmail),
        `the decision email to ${salesEmail} for ${memoNumber}`,
        MAIL_TIMEOUT_MS,
      );
      expect(decided.Subject).toMatch(/approved/i);
    });

    // ------------------------------------------------------------------------ 7. the audit trail
    await test.step('the audit timeline shows the whole story to finance and is hidden from sales', async () => {
      // Finance is not a signer here; it holds audit.read, which is all this step needs.
      const finance = await signIn('finance');
      await finance.goto(`/memos/${memoId}`);
      const timeline = finance.getByRole('region', { name: 'Audit timeline' });
      await expect(timeline).toBeVisible();
      // Labels are the audit action names in plain language (kernel-ui.ts: `approvals.approve` -> "Approved").
      // The memo page shows the historical `test_memos.*` actions under the product name
      // (`test_memos.insert` -> "Memo created").
      // The memo page lists events for the memo itself and for its approval request.
      await expect(timeline.getByText('Memo created', { exact: true })).toHaveCount(1);
      await expect(timeline.getByText('Submitted for approval', { exact: true })).toHaveCount(1);
      await expect(timeline.getByText('Approved', { exact: true })).toHaveCount(2);
      // Created -> submitted -> approved on the memo, so at least two updates.
      expect(
        await timeline.getByText('Memo updated', { exact: true }).count(),
        'memo status changes in the trail',
      ).toBeGreaterThanOrEqual(2);
      expect(
        await timeline.getByText('Approval request updated', { exact: true }).count(),
        'request status changes in the trail',
      ).toBeGreaterThanOrEqual(1);

      // Sales has no audit.read, so the same page explains why the trail is empty for them.
      await sales.goto(`/memos/${memoId}`);
      await expect(sales.getByText('Approved', { exact: true }).first()).toBeVisible();
      await expect(
        sales.getByText('The audit trail is only open to roles with audit access', {
          exact: false,
        }),
      ).toBeVisible();

      // The chain check itself needs a token the browser never has: see the header comment. This
      // only confirms the route is closed to an anonymous caller.
      const month = new Date().toISOString().slice(0, 7);
      expect
        .soft(await statusWithoutToken(`/v1/audit/verify?month=${month}`), 'verify without a token')
        .toBe(401);
    });
  } finally {
    await Promise.all(opened.map((signed) => signed.context.close()));
  }
});
