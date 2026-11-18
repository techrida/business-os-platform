import { expect, test, type Page } from '@playwright/test';

import { statusWithoutToken } from './helpers/api';
import {
  createDraftMemo,
  inboxRow,
  minimalPdf,
  openFromInbox,
  readPreviewSteps,
  signInAs,
  submitMemo,
  type Signed,
} from './helpers/memo-flow';
import { sentTo, waitForMessage } from './helpers/mailpit';
import { persona } from './helpers/personas';

/**
 * THE P1 EXIT TEST, full stack. model.js: "A test document goes through a two-step approval with
 * no self-approval, an email, a scanned upload and a full audit trail." The same story runs at the
 * API layer in apps/api/test/e2e/approvals.e2e.test.ts with fakes; here nothing is faked: real
 * ZITADEL with a TOTP second factor, real ClamAV, real Mailpit, the real API and worker, and the
 * real Workspace, driven only through the browser's accessible controls.
 *
 * What it proves, in order (one test, one `test.step` each, separate browser contexts per persona):
 *  1. Sales signs in with password + TOTP and saves an NPR 50,000 memo.
 *  2. A real PDF uploaded from a buffer is scanned by ClamAV and shows "Scan passed" with a
 *     Download link (the scan finishes asynchronously, so this waits up to 60 s).
 *  3. Before submitting, the route preview shows exactly 2 steps (accountant, then finance), each
 *     with a reason. Sales submits, and the memo becomes "Submitted".
 *  4. No self-approval: Sales's inbox says in plain words that its roles do not include approvals,
 *     and the request's own page (opened by URL) offers Sales no Approve button.
 *  5. The Accountant signs in, sees the memo in the inbox with the same reason the preview gave,
 *     and approves (banner "Your approval was recorded.").
 *  6. Finance signs in, sees it (step 2 is now active), and approves. The memo page shows
 *     "Approved".
 *  7. Mailpit holds the "Approval needed" email to the accountant and to finance, and the decided
 *     email to Sales.
 *  8. Finance's Audit timeline on the memo page lists the memo being created and changed, the
 *     submit, and two approvals; Sales (no audit permission) is told the trail is hidden.
 *
 * What it does NOT prove: the audit hash chain (`GET /v1/audit/verify`). That route needs a
 * bearer token and the Workspace never exposes one to the browser, and there is no Workspace
 * route that calls it, so the spec only checks (softly) that the route refuses an anonymous call.
 * `approvals.e2e.test.ts` verifies the chain at the API layer.
 *
 * Requires: `pnpm stack:up:files` (ClamAV), `pnpm seed` (personas with TOTP), the API and worker
 * running with SMTP pointed at Mailpit, and BASE_URL or the default https://app.localhost.
 */

// Real ClamAV scans take a few seconds, mail goes through BullMQ: allow generous waits.
const SCAN_TIMEOUT_MS = 60_000;

// The full Chromium build includes its inline PDF viewer. The lightweight headless shell does not.
test.use({ channel: 'chromium' });

/** Approves from an inbox detail page and checks the confirmation banner on the inbox. */
async function approve(page: Page, comment: string): Promise<void> {
  await page.getByLabel('Comment', { exact: true }).fill(comment);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForURL(/\/inbox\?decided=approve/, { timeout: 30_000 });
  await expect(page.getByText('Your approval was recorded.')).toBeVisible();
}

test('P1 exit: a memo with a scanned upload goes through two approvals, emails and an audit trail', async ({
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
    const { memoId, memoNumber } = await test.step('sales creates an NPR 50,000 memo', async () => {
      // 50,000 is what routes the memo through the accountant AND finance (two steps).
      return createDraftMemo(sales, { title, amount: '50000' });
    });

    // ------------------------------------------------------- 2. upload; ClamAV marks it clean
    await test.step('sales uploads a PDF and the real ClamAV scan passes', async () => {
      await sales.waitForLoadState('networkidle');
      const chooser = sales.waitForEvent('filechooser');
      await sales.getByRole('button', { name: 'Upload file', exact: true }).click();
      await (
        await chooser
      ).setFiles({
        name: 'exit-quote.pdf',
        mimeType: 'application/pdf',
        buffer: minimalPdf('Exit e2e quote'),
      });

      const file = sales
        .getByRole('list', { name: 'Attachments' })
        .getByRole('listitem')
        .filter({ hasText: 'exit-quote.pdf' });
      await expect(file).toBeVisible({ timeout: 30_000 });
      // The panel polls every 3 s while the file is "Scanning" and refreshes the page when done.
      await expect(file).toContainText('Scan passed', { timeout: SCAN_TIMEOUT_MS });
      const open = sales.getByRole('button', { name: 'Preview exit-quote.pdf' });
      await expect(open).toBeVisible();
      const previewResponse = sales.waitForResponse((response) =>
        /\/api\/documents\/[^/]+\/versions\/[^/]+\/preview$/.test(response.url()),
      );
      await open.click();
      const preview = sales.getByRole('dialog', { name: 'exit-quote.pdf', exact: true });
      await expect(preview.getByTitle('Preview of exit-quote.pdf')).toBeVisible();
      expect((await previewResponse).status()).toBe(200);
      await expect(preview.getByRole('link', { name: 'Download', exact: true })).toBeVisible();
      await sales.keyboard.press('Escape');
      await expect(preview).toHaveCount(0);
      await expect(open).toBeFocused();
    });

    // ------------------------------------------------------ 3. preview, then submit for approval
    const preview =
      await test.step('the preview shows 2 steps with reasons, then sales submits', async () => {
        const steps = await readPreviewSteps(sales);
        expect(steps, 'two-step route for NPR 50,000').toHaveLength(2);
        expect(steps[0]?.who).toContain('Dev Accountant');
        expect(steps[1]?.who).toContain('Dev Finance');
        return steps;
      });
    const stepOneReason = preview[0]?.reason ?? '';
    const stepTwoReason = preview[1]?.reason ?? '';

    const requestId = await test.step('sales submits', async () => {
      const id = await submitMemo(sales);
      await expect(sales.getByText('Submitted', { exact: true })).toBeVisible();
      await expect(
        sales.getByText(
          'This memo is waiting for approval. It cannot be edited until it is returned.',
        ),
      ).toBeVisible();
      return id;
    });

    // ------------------------------------------------------------------ 4. no self-approval
    await test.step('sales cannot approve their own memo: inbox says so, and the request has no Approve button', async () => {
      // `GET /v1/approvals/inbox` needs approvals.requests.act, which sales lacks: a 403 that the
      // page turns into words.
      await sales.goto('/inbox');
      await expect(sales.getByText('Your roles do not include approvals')).toBeVisible();
      await expect(
        sales.getByText('The inbox is for people who approve documents.', { exact: false }),
      ).toBeVisible();

      // The request itself may be read by its requester (approvals.requests.read, own scope), but
      // the page offers no decision.
      await sales.goto(`/inbox/${requestId}`);
      await expect(
        sales.getByText(
          'This request is not waiting on you right now. You can read it, but you cannot decide it.',
        ),
      ).toBeVisible();
      await expect(sales.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(sales.getByRole('button', { name: 'Reject' })).toHaveCount(0);
    });

    // ------------------------------------------------------------------ 5. accountant approves
    const accountant = await signIn('accountant');
    await test.step('the accountant sees the reason in the inbox and approves step 1', async () => {
      const found = await openFromInbox(accountant, title, stepOneReason);
      expect(found.requestId).toBe(requestId);
      const frozenFiles = accountant.getByRole('region', { name: 'Attachments', exact: true });
      await expect(
        frozenFiles.getByRole('button', { name: 'exit-quote.pdf', exact: true }),
      ).toBeVisible();
      await approve(accountant, 'Looks right. Step 1 approved by the exit spec.');
      // Decided: it leaves this person's inbox.
      await expect(inboxRow(accountant, title)).toHaveCount(0);
    });

    // --------------------------------------------------------------------- 6. finance approves
    const finance = await signIn('finance');
    await test.step('finance sees step 2 and approves; the memo is approved', async () => {
      const found = await openFromInbox(finance, title, stepTwoReason);
      expect(found.requestId).toBe(requestId);
      await approve(finance, 'Budget available. Step 2 approved by the exit spec.');

      // The memo status follows the request's decision; allow a moment, then reload to read it.
      await finance.goto(`/memos/${memoId}`);
      await expect(async () => {
        await finance.reload();
        await expect(finance.getByText('Approved', { exact: true })).toBeVisible({
          timeout: 3_000,
        });
      }).toPass({ timeout: 30_000 });
      await expect(finance.getByText('This memo was approved.')).toBeVisible();
    });

    // -------------------------------------------------------------------------- 7. the emails
    await test.step('Mailpit holds the pending emails and the decided email', async () => {
      const forThisMemo = (subject: string): boolean => subject.includes(memoNumber);
      const accountantEmail = persona('accountant').username;
      const financeEmail = persona('finance').username;
      const salesEmail = persona('sales').username;

      // approval.pending: "Approval needed: <type> <number>", one per step as it activates.
      await waitForMessage(
        (m) =>
          forThisMemo(m.Subject) &&
          m.Subject.startsWith('Approval needed') &&
          sentTo(m, accountantEmail),
        `the "Approval needed" email to ${accountantEmail} for ${memoNumber}`,
        SCAN_TIMEOUT_MS,
      );
      await waitForMessage(
        (m) =>
          forThisMemo(m.Subject) &&
          m.Subject.startsWith('Approval needed') &&
          sentTo(m, financeEmail),
        `the "Approval needed" email to ${financeEmail} for ${memoNumber}`,
        SCAN_TIMEOUT_MS,
      );
      // approval.decided goes to the requester: "<type> <number>: <decision>".
      const decided = await waitForMessage(
        (m) =>
          forThisMemo(m.Subject) &&
          !m.Subject.startsWith('Approval needed') &&
          sentTo(m, salesEmail),
        `the decision email to ${salesEmail} for ${memoNumber}`,
        SCAN_TIMEOUT_MS,
      );
      expect(decided.Subject).toMatch(/approved/i);
    });

    // ------------------------------------------------------------------------ 8. the audit trail
    await test.step('the audit timeline shows the whole story to finance and is hidden from sales', async () => {
      await finance.goto(`/memos/${memoId}`);
      const timeline = finance.getByRole('region', { name: 'Audit timeline' });
      await expect(timeline).toBeVisible();
      // Labels are the audit action names made readable (`approvals.approve` -> "Approvals approve").
      // The memo page lists events for the memo itself and for its approval request.
      await expect(timeline.getByText('Test memos insert', { exact: true })).toHaveCount(1);
      await expect(timeline.getByText('Approvals submit', { exact: true })).toHaveCount(1);
      await expect(timeline.getByText('Approvals approve', { exact: true })).toHaveCount(2);
      await expect(timeline.getByText('Dev Sales', { exact: true }).first()).toBeVisible();
      await expect(timeline.getByText('Dev Accountant', { exact: true }).first()).toBeVisible();
      await expect(timeline.getByText('Dev Finance', { exact: true }).first()).toBeVisible();
      // Created -> submitted -> approved on the memo, so at least two updates.
      expect(
        await timeline.getByText('Test memos update', { exact: true }).count(),
        'memo status changes in the trail',
      ).toBeGreaterThanOrEqual(2);
      expect(
        await timeline.getByText('Approval requests update', { exact: true }).count(),
        'request status changes in the trail',
      ).toBeGreaterThanOrEqual(1);

      // Sales has no audit.read, so the same page explains why the trail is empty for them.
      await sales.goto(`/memos/${memoId}`);
      await expect(sales.getByText('Approved', { exact: true })).toBeVisible();
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

// Attachment interaction and recovery regression, on the same real P1 stack.
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
      if (index === 0) await upload.click();
      else {
        await upload.focus();
        await page.keyboard.press('Enter');
      }
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
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

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
    await page.getByRole('button', { name: 'Submit for approval', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Cannot submit yet' })).toContainText(
      'Virus found',
    );
    await page.keyboard.press('Escape');
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
