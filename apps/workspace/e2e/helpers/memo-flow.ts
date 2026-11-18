import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { persona } from './personas';
import { signInOnZitadel } from './zitadel-login';

/**
 * The browser steps exit.spec.ts and inbox.spec.ts share: sign in as a persona in its own browser
 * context, create and submit a memo, and open an inbox item. Every selector is a role or a label
 * the pages expose (checked against apps/workspace/src/app/(app) on 2026-11-08); when a screen's
 * wording changes, this is the one file to fix.
 */

const authOrigin = process.env.BOS_E2E_AUTH_ORIGIN ?? 'https://auth.localhost';

export interface Signed {
  context: BrowserContext;
  page: Page;
}

/**
 * A fresh browser context (so cookies never leak between personas) signed in through the real
 * ZITADEL form, password and TOTP. The caller closes the context.
 */
export async function signInAs(browser: Browser, baseURL: string, key: string): Promise<Signed> {
  const who = persona(key);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL((url) => url.origin === authOrigin, { timeout: 30_000 });
  await signInOnZitadel(page, who, new URL(baseURL).origin);
  return { context, page };
}

/**
 * A minimal but valid one-page PDF built from a template, so no fixture file sits on disk. Offsets
 * in the xref table are computed, because a reader (and ClamAV's PDF parser) rejects wrong ones.
 */
export function minimalPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 20 100 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface DraftMemo {
  memoId: string;
  /** For example `MEMO-2082/83-00001`; it appears in every email subject about this memo. */
  memoNumber: string;
}

/** Fills the New memo form and saves a draft; ends on the memo's own page. */
export async function createDraftMemo(
  page: Page,
  input: { title: string; amount: string },
): Promise<DraftMemo> {
  await page.goto('/memos/new');
  // The form's inputs are controlled: text typed before React hydrates is wiped. Wait for the
  // page's own requests to settle, then confirm the values stuck.
  await page.waitForLoadState('networkidle');
  const title = page.getByLabel('Subject', { exact: true });
  const amount = page.getByLabel('Amount', { exact: true });
  await title.fill(input.title);
  await page.getByLabel('Body', { exact: true }).fill('Created by the Playwright exit spec.');
  await amount.fill(input.amount);
  await expect(title).toHaveValue(input.title);
  await expect(amount).toHaveValue(input.amount);
  const department = page.getByLabel('Department', { exact: true });
  if (!(await department.inputValue())) await department.selectOption({ index: 1 });
  // These are real seeded directory names, never synthetic entries injected into the form.
  const signers = ['Dev Accountant', 'Dev Finance'];
  const amountNpr = Number(input.amount.replace(/[,\s]/g, ''));
  if (amountNpr > 100000) signers.push('Dev Management');
  if (amountNpr > 1000000) signers.push('Dev Founder');
  // A new memo starts with two blank "Recommended by" rows and an "Approved by" box; each is an editable combobox
  // (click it, type, pick). Rows beyond the first two are added; a blank row is ignored when the memo is saved.
  for (let i = 0; i < signers.length; i++) {
    const approver = i === signers.length - 1;
    if (!approver && i >= 2) {
      await page.getByRole('button', { name: 'Add recommender', exact: true }).click();
    }
    const box = page.getByRole('combobox', {
      name: approver ? 'Approved by' : `Recommended by ${i + 1}`,
      exact: true,
    });
    await box.click();
    await box.fill(signers[i]!);
    await page.getByRole('option', { name: new RegExp(`^${signers[i]}(?: |$)`) }).click();
    await expect(box).toHaveValue(signers[i]!);
  }

  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.waitForURL(/\/memos\/[0-9a-f-]{36}(\?.*)?$/, { timeout: 30_000 });
  const memoId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(page.getByRole('heading', { level: 1, name: input.title })).toBeVisible();
  const header = await page.getByRole('main').locator('p').first().innerText();
  const memoNumber = /MEMO-[\w/-]*\d{5}/.exec(header)?.[0];
  if (memoNumber === undefined) {
    throw new Error(`No memo number like MEMO-2082/83-00001 in the memo header: "${header}"`);
  }
  return { memoId, memoNumber };
}

/** The approval route panel on a draft memo. It exists only while the memo can still change. */
export const routePanel = (page: Page) => page.getByRole('region', { name: 'Approval route' });

/**
 * Reads the previewed steps from a draft memo's page: who each step asks, and the reason given.
 * Throws unless every step has a non-empty reason.
 */
export async function readPreviewSteps(page: Page): Promise<{ who: string; reason: string }[]> {
  const steps = routePanel(page).getByRole('listitem');
  await expect(steps.first()).toBeVisible();
  const count = await steps.count();
  const out: { who: string; reason: string }[] = [];
  for (let i = 0; i < count; i++) {
    const item = steps.nth(i);
    // Each step is `<span>who</span> ... <p>reason</p>`.
    const reason = (await item.locator('p').first().innerText()).trim();
    const text = await item.innerText();
    expect(reason.length, `step ${i + 1} has no reason; step text was "${text}"`).toBeGreaterThan(
      0,
    );
    out.push({ who: text, reason });
  }
  return out;
}

/** Presses "Submit for approval" and returns the approval request id from the memo's link. */
export async function submitMemo(page: Page): Promise<string> {
  const submit = page.getByRole('button', { name: 'Submit for approval', exact: true });
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();
  await page
    .getByRole('dialog', { name: 'Submit for approval?' })
    .getByRole('button', { name: 'Submit for approval', exact: true })
    .click();
  await page.waitForURL(/[?&]submitted=pending\b/, { timeout: 30_000 });
  await expect(page.getByText('Submitted for approval.', { exact: false })).toBeVisible();
  const link = page.getByRole('link', { name: 'View the approval route and history' });
  const href = (await link.getAttribute('href')) ?? '';
  const requestId = /\/inbox\/([0-9a-f-]{36})$/.exec(href)?.[1];
  if (requestId === undefined) throw new Error(`Unexpected approval link "${href}"`);
  return requestId;
}

/** The inbox row for a memo, found by its (unique) title. The inbox is a table named "Waiting approvals". */
export const inboxRow = (page: Page, title: string) =>
  page
    .getByRole('table', { name: 'Waiting approvals' })
    .getByRole('row')
    .filter({ hasText: title });

/**
 * Opens the inbox, waits for the memo's row to appear (the request is created in the submitting
 * transaction, so this is normally immediate; the reload loop covers a slow read), checks the row
 * shows the reason, opens it, and returns once the detail page and its "why" panel are showing.
 */
export async function openFromInbox(
  page: Page,
  title: string,
  reason: string,
): Promise<{ requestId: string }> {
  await page.goto('/inbox');
  const row = inboxRow(page, title);
  await expect(async () => {
    await page.reload();
    await expect(row).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(row).toContainText(reason);

  await row.getByRole('link', { name: title }).click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const requestId = new URL(page.url()).pathname.split('/').pop() ?? '';
  await expect(page.getByRole('region', { name: 'Why this is in your inbox' })).toContainText(
    reason,
  );
  // The decision form is a client component with a controlled textarea; let it hydrate.
  await page.waitForLoadState('networkidle');
  return { requestId };
}
