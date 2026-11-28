import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { timeAction } from './flow-timing';
import { persona } from './personas';
import { chooseOption, hasSelection, selectByLabel } from './select';
import { signInOnZitadel } from './zitadel-login';

/**
 * The browser steps exit.spec.ts and inbox.spec.ts share: sign in as a persona in its own browser
 * context, create and submit an internal memo (named signers, no money, no files), and open an inbox
 * item. Every selector is a role or a label the pages expose (checked against
 * apps/workspace/src/app/(app) on 2026-11-12); when a screen's wording changes, this is the one file to fix.
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
  // Override a runner's storageState so a portal vendor cannot pre-authenticate a staff context.
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page).toHaveURL((url) => url.origin === authOrigin, { timeout: 30_000 });
  await signInOnZitadel(page, who, new URL(baseURL).origin);
  return { context, page };
}

export interface DraftMemo {
  memoId: string;
  /** For example `MEMO-2082/83-00001`; it appears in every email subject about this memo. */
  memoNumber: string;
}

/**
 * Fills the New memo form and saves a draft; ends on the memo's own page. An internal memo has no amount and no
 * files: the author names the signers, and those people are the approval route, in this order. Every recommender
 * must be a seeded person who can decide approvals, for example "Dev Management". The approver must be someone the
 * Memo approver rule allows ("Approved by" lists no one else): for a Sales author, "Dev Founder".
 */
export async function createDraftMemo(
  page: Page,
  input: { title: string; recommenders: string[]; approver: string },
): Promise<DraftMemo> {
  await page.goto('/memos/new');
  // The form's inputs are controlled: text typed before React hydrates is wiped. Wait for the
  // page's own requests to settle, then confirm the values stuck.
  await page.waitForLoadState('networkidle');
  const title = page.getByLabel('Subject', { exact: true });
  await title.fill(input.title);
  await page.getByLabel('Body', { exact: true }).fill('Created by the Playwright exit spec.');
  await expect(title).toHaveValue(input.title);
  const department = selectByLabel(page, 'Department');
  // Department is required, so its list has no empty option: index 0 is the first department.
  if (!(await hasSelection(department))) await chooseOption(department, { index: 0 });
  // These are real seeded directory names, never synthetic entries injected into the form.
  const signers = [...input.recommenders, input.approver];
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
    // The rule arrives after the form and may already have chosen the person: the live preview then names them under
    // "Approved by" while the box itself stays empty. Wait a moment for that before choosing by hand.
    if (approver) {
      const prefilled = await expect(page.getByLabel('Memo preview'))
        .toContainText(signers[i]!, { timeout: 5_000 })
        .then(
          () => true,
          () => false,
        );
      if (prefilled) continue;
    }
    await box.click();
    await box.fill(signers[i]!);
    // Match the option's own name line, whole. A prefix match also picks "Dev Management Two" when
    // "Dev Management" is asked for. The line is the person's name, or "Name (title)" when two people share a name.
    const name = signers[i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const option = page
      .getByRole('option')
      .filter({ has: page.getByText(new RegExp(`^${name}(?: \\(.+\\))?$`)) });
    await expect(option).toBeEnabled();
    await option.click();
    await expect(box).toHaveValue(signers[i]!);
    if (i === 0 && !approver) {
      // A typed label alone cannot submit a signer. Check the real form field, then verify
      // "Approved by" does not offer this recommender: the approver rule lists only eligible people.
      const template = JSON.parse(await page.locator('input[name="template"]').inputValue()) as {
        recommenderUserIds: string[];
      };
      expect(template.recommenderUserIds).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/i)]);
      const finalSigner = page.getByRole('combobox', { name: 'Approved by', exact: true });
      await finalSigner.fill(signers[i]!);
      await expect(option).toHaveCount(0);
      await finalSigner.press('Escape');
    }
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
  const confirm = page
    .getByRole('dialog', { name: 'Submit for approval?' })
    .getByRole('button', { name: 'Submit for approval', exact: true });
  await timeAction('submit-memo', confirm, async () => {
    await page.waitForURL(/[?&]submitted=pending\b/, { timeout: 30_000 });
    await expect(page.getByText('Submitted for approval.', { exact: false })).toBeVisible();
  });
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
 * shows the reason, opens it, and returns once the detail page is showing.
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

  await row.getByRole('link', { name: title, exact: true }).click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const requestId = new URL(page.url()).pathname.split('/').pop() ?? '';
  // The reason shows in the inbox row above; the decision card no longer repeats it.
  await expect(page.getByRole('region', { name: 'Why this is in your inbox' })).toHaveCount(0);
  // The decision form is a client component with a controlled textarea; let it hydrate.
  await page.waitForLoadState('networkidle');
  return { requestId };
}
