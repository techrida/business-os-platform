import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { getJson } from '../helpers/api';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { mailOrigin, sentTo, waitForMessage } from '../helpers/mailpit';

/**
 * The quotation detail page, against the real stack: the summary and totals, the revisions dialog,
 * the PDF download, and the three actions (send, record outcome, revise).
 *
 * The quotation endpoints and their seed data are not in the stack yet, and a quotation moves one
 * step per run (a sent quotation cannot be sent again), so each test takes a fixture id from the
 * environment and skips itself when it is unset. Every fixture is one quotation owned by the
 * `sales` persona's organization:
 *
 *   BOS_E2E_QUOTATION_APPROVED   status Approved, rendered PDF scanned clean, valid for at least a
 *                                week, with a contact that has an email address.
 *   BOS_E2E_QUOTATION_CONTACT    that contact's email address (the send test looks for the mail).
 *   BOS_E2E_QUOTATION_SCANNING   status Approved, but the rendered PDF is not clean yet.
 *   BOS_E2E_QUOTATION_SENT       status Sent, still waiting for the customer's answer.
 *   BOS_E2E_QUOTATION_REVISABLE  status Rejected (or Expired): Revise is offered.
 *   BOS_E2E_QUOTATION_DOWNLOAD   any quotation with a clean PDF (may be the approved one if the
 *                                download test runs first; it clicks the link exactly once, because
 *                                every call to the route issues a single-use signed link).
 *
 * The `dev` project runs this spec through its `p2/*.spec.ts` match.
 */

/**
 * A fixture variable holds one id, or a comma-separated list: the specs that use a quotation up (send, record outcome,
 * revise) take the one at their repeat index, so `--repeat-each` finds a fresh quotation each time.
 */
const fixture = (name: string, info: TestInfo): string | undefined => {
  const list = (process.env[`BOS_E2E_QUOTATION_${name}`] ?? '').split(',').filter(Boolean);
  // One value serves every repeat (a contact address); a list needs one entry per repeat, or the test skips.
  return list.length === 1 ? list[0] : list[info.repeatEachIndex];
};

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/quotations/${id}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

async function withSales<T>(
  browser: Parameters<typeof signInAs>[0],
  baseURL: string | undefined,
  run: (signed: Signed) => Promise<T>,
): Promise<T> {
  const signed = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
  try {
    return await run(signed);
  } finally {
    await signed.context.close();
  }
}

test('the detail page shows the summary, the totals and every revision in a dialog', async ({
  browser,
  baseURL,
}, testInfo) => {
  const id = fixture('SENT', testInfo) ?? fixture('APPROVED', testInfo);
  test.skip(id === undefined, 'BOS_E2E_QUOTATION_SENT or _APPROVED is not set');
  await withSales(browser, baseURL, async ({ page }) => {
    await open(page, id ?? '');
    await expect(page.getByText('Current revision')).toBeVisible();
    await expect(page.getByText('Totals')).toBeVisible();
    await expect(page.getByText('Status history')).toBeVisible();

    const revisions = page.getByRole('button', { name: /^All revisions \(\d+\)$/ });
    await revisions.click();
    const dialog = page.getByRole('dialog', { name: /^Revisions of / });
    await expect(dialog.getByRole('table', { name: /^Revisions of / })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(revisions).toBeFocused();

    await revisions.press('Enter');
    await dialog.locator('footer').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(revisions).toBeFocused();
  });
});

test('the customer PDF downloads from one click on the link', async ({
  browser,
  baseURL,
}, testInfo) => {
  const id = fixture('DOWNLOAD', testInfo);
  test.skip(id === undefined, 'BOS_E2E_QUOTATION_DOWNLOAD is not set');
  await withSales(browser, baseURL, async ({ page }) => {
    await open(page, id ?? '');
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: /^Download/ })
      .first()
      .click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/i);
  });
});

test('Send is off, with its reason in words, while the PDF is not clean', async ({
  browser,
  baseURL,
}, testInfo) => {
  const id = fixture('SCANNING', testInfo);
  test.skip(id === undefined, 'BOS_E2E_QUOTATION_SCANNING is not set');
  await withSales(browser, baseURL, async ({ page }) => {
    await open(page, id ?? '');
    const send = page.getByRole('button', { name: 'Send to customer' });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).toHaveAccessibleDescription(/PDF is still being/);
    // Reachable by keyboard, so the reason is announced; Enter opens nothing.
    await send.focus();
    await send.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test('Send gives the customer a portal link by email, never the file', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const id = fixture('APPROVED', testInfo);
  const contact = fixture('CONTACT', testInfo);
  test.skip(id === undefined || contact === undefined, 'APPROVED or CONTACT is not set');
  await withSales(browser, baseURL, async ({ page }) => {
    await open(page, id ?? '');
    const trigger = page.getByRole('button', { name: 'Send to customer' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: /^Send / });
    await expect(dialog).toContainText('never sent as a file');

    const select = dialog.getByRole('combobox', { name: 'Send to', exact: true });
    const message = dialog.getByLabel('Message (optional)');
    const footer = dialog.locator('footer');
    const submit = footer.getByRole('button', { name: 'Send to customer' });
    const key = dialog.locator('input[name="idempotencyKey"]');
    const initialKey = await key.inputValue();
    expect(initialKey).toBeTruthy();

    // Clear the preselected contact. Hold this request to check the pending state before validation.
    await select.click();
    await select.fill('');
    await message.fill('Thank you for considering this quotation.');
    let releaseRequest: () => void = () => {};
    const pendingRequest = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route('**/quotations/**', async (route) => {
      if (route.request().headers()['next-action']) await pendingRequest;
      await route.continue();
    });
    try {
      await submit.click();
      await expect(dialog.getByText('Sending the quotation')).toBeVisible();
      await expect(footer.getByRole('button', { name: 'Cancel' })).toBeDisabled();
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
      await expect(submit).toBeDisabled();
      await page.keyboard.press('Escape');
      await page.mouse.click(2, 2);
      await expect(dialog).toHaveAttribute('data-state', 'open');
    } finally {
      releaseRequest();
    }
    await expect(dialog.getByText('Choose who should receive it.')).toBeVisible();
    await expect(select).toBeFocused();
    await footer.getByRole('button', { name: 'Cancel' }).click();
    await expect(trigger).toBeFocused();
    await trigger.press('Enter');
    await expect(message).toHaveValue('Thank you for considering this quotation.');
    await expect(key).toHaveValue(initialKey);

    await select.click();
    await dialog
      .getByRole('option')
      .filter({ hasText: contact ?? '' })
      .first()
      .click();
    await submit.click();
    await expect(dialog.getByText('Sent to').first()).toBeVisible({ timeout: 30_000 });

    // Closing reloads the page, which now shows the new status.
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();

    const mail = await waitForMessage((m) => sentTo(m, contact ?? ''), `a mail to ${contact}`);
    const full = await getJson<{ Attachments?: unknown[]; Text?: string }>(
      `${mailOrigin()}/api/v1/message/${mail.ID}`,
    );
    expect(full.Attachments ?? []).toHaveLength(0);
    expect(full.Text ?? '').toMatch(/https?:\/\//);
  });
});

test('Record outcome needs evidence to accept and a comment to reject', async ({
  browser,
  baseURL,
}, testInfo) => {
  const id = fixture('SENT', testInfo);
  test.skip(id === undefined, 'BOS_E2E_QUOTATION_SENT is not set');
  await withSales(browser, baseURL, async ({ page }) => {
    await open(page, id ?? '');
    await page.getByRole('button', { name: 'Record outcome' }).click();
    const dialog = page.getByRole('dialog', { name: /^Record outcome for / });
    const submit = dialog.getByRole('button', { name: 'Record outcome' });

    await submit.click();
    await expect(
      dialog.getByText('Choose whether the customer accepted or rejected.'),
    ).toBeVisible();

    await dialog.getByRole('radio', { name: 'Accepted', exact: true }).click();
    await submit.click();
    await expect(
      dialog.getByText('Choose at least one kind of evidence the customer gave.'),
    ).toBeVisible();

    await dialog.getByRole('radio', { name: 'Rejected', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Signed quotation' }).uncheck();
    await submit.click();
    await expect(dialog.getByText('Say why the customer said no.', { exact: false })).toBeVisible();

    await dialog.getByLabel('Comment').fill('Went with a competitor.');
    await submit.click();
    await expect(dialog.getByText('Recorded as rejected').first()).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('Rejected by customer', { exact: true }).first()).toBeVisible();
  });
});

test('Revise needs a reason, then opens the new draft for editing', async ({
  browser,
  baseURL,
}, testInfo) => {
  const id = fixture('REVISABLE', testInfo);
  test.skip(id === undefined, 'BOS_E2E_QUOTATION_REVISABLE is not set');
  await withSales(browser, baseURL, async ({ page }) => {
    await open(page, id ?? '');
    await page.getByRole('button', { name: 'Revise', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Revise / });

    await dialog.getByRole('button', { name: 'Start revision' }).click();
    await expect(dialog.getByText('Say why you are revising it.', { exact: false })).toBeVisible();

    await dialog.getByLabel('Why are you revising it?').fill('Customer asked for a smaller scope.');
    await dialog.getByRole('button', { name: 'Start revision' }).click();
    await page.waitForURL(new RegExp(`/quotations/${id}/edit$`), { timeout: 30_000 });
  });
});
