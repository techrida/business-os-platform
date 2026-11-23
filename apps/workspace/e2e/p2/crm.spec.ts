import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';
import { chooseOption, optionLabels, selectByName } from '../helpers/select';
import { ensureLeadOwner } from '../helpers/lead-owner';

/** Moves a New lead to Contacted: the move needs the call, email or meeting that made the contact (D48). */
async function markContacted(page: Page) {
  await page.getByRole('button', { name: 'Mark contacted', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark this lead contacted?' });
  await dialog.getByRole('radio', { name: 'Call', exact: true }).click();
  await dialog.getByLabel('Note', { exact: true }).fill('Intro call');
  await dialog.getByRole('button', { name: 'Mark contacted', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Moved to Contacted.')).toBeVisible();
}

/**
 * The CRM screens against the real stack, as the sales persona: create a lead, log a call, move
 * it to Contacted with Mark contacted, see the board, and check that system-only stages are never
 * offered. Needs the P2 API routes (leads, opportunities, activities) and the CRM nav wired in.
 * NOT RUN by the unit that wrote it; the lead runs it with the stack up.
 */

test('a salesperson creates a lead, logs a call and moves it with the Move control', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const title = `CRM e2e ${new Date().toISOString()}`;
  const { context, page } = await signInAs(browser, appBase, 'sales');

  try {
    await test.step('create a lead', async () => {
      await page.goto('/leads/new');
      await page.getByRole('textbox', { name: 'Lead title', exact: true }).fill(title);
      await chooseOption(selectByName(page, 'source'), 'referral');
      await page
        .getByRole('textbox', { name: 'Company or organization', exact: true })
        .fill('Binford Ltd.');
      await page.getByLabel('Contact person').fill('Sunita Shrestha');
      // A lead needs an email or at least one phone number.
      await page
        .getByRole('textbox', { name: 'Email', exact: true })
        .fill(`sunita.${Date.now()}@example.test`);
      await ensureLeadOwner(page);
      await page.getByRole('button', { name: 'Create lead' }).click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    });

    await test.step('a refused form keeps what was typed and names the field', async () => {
      await page.goto('/leads/new');
      await page.getByRole('textbox', { name: 'Lead title', exact: true }).fill('Half a lead');
      await page.getByRole('button', { name: 'Create lead' }).click();
      await expect(page.getByText('Choose where the lead came from.')).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Lead title', exact: true })).toHaveValue(
        'Half a lead',
      );
    });

    await test.step('log a call on the lead', async () => {
      await page.goto('/leads');
      await page.getByRole('link', { name: title }).click();
      await page.getByLabel('What it was about').fill('Intro call');
      await page.getByRole('button', { name: 'Log activity' }).click();
      await expect(page.getByText('Activity logged.')).toBeVisible();
      await expect(page.getByText('Intro call')).toBeVisible();
    });

    await test.step('move to Contacted through Mark contacted, no mouse drag', async () => {
      await markContacted(page);
    });

    await test.step('Mark lost needs a reason and a note', async () => {
      await page.getByRole('button', { name: 'Mark lost', exact: true }).click();
      const lost = page.getByRole('dialog', { name: 'Mark this lead lost?' });
      await lost.getByRole('button', { name: 'Mark lost', exact: true }).click();
      await expect(
        lost.getByText('Choose a reason from the list, or add a new one.'),
      ).toBeVisible();
      await expect(
        lost.getByText('Add a note for the record, up to 2,000 characters.'),
      ).toBeVisible();
      await lost.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(lost).toBeHidden();
    });

    await test.step('the board shows the lead in Contacted and Converted takes no cards', async () => {
      await page.goto('/leads?view=board');
      const contacted = page.getByRole('region', { name: 'Contacted' });
      await expect(contacted.getByRole('link', { name: title })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Converted' })).toContainText('Set by Convert');
    });
  } finally {
    await context.close();
  }
});

test('opportunities never offer Won or Quotation Sent as a move', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const appBase = baseURL ?? 'https://app.localhost';
  const { context, page } = await signInAs(browser, appBase, 'sales');
  // The board draws its columns only when at least one opportunity exists; a fresh stack shows "No
  // opportunities yet" instead. So this test makes its own: a qualified lead, converted through the UI.
  // The company name is unique per run because Convert refuses a customer with the same normalised name.
  const stamp = Date.now();
  const title = `CRM e2e opportunity ${stamp}`;
  const email = `board-test-${stamp}@example.test`;
  try {
    await test.step('convert a qualified lead into an opportunity', async () => {
      await page.goto('/leads/new');
      await page.waitForLoadState('networkidle');
      await page.getByRole('textbox', { name: 'Lead title', exact: true }).fill(title);
      await chooseOption(selectByName(page, 'source'), 'referral');
      await page
        .getByRole('textbox', { name: 'Company or organization', exact: true })
        .fill(`Board Test ${stamp} Pvt. Ltd.`);
      await page.getByLabel('Contact person').fill(`Board Tester ${stamp}`);
      // A lead needs an email or at least one phone number.
      await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email);
      await ensureLeadOwner(page);
      await page.getByRole('button', { name: 'Create lead' }).click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await page.waitForLoadState('networkidle');

      // A lead must be Qualified before it can be converted: New, Contacted, Qualified.
      await markContacted(page);
      await page.getByRole('button', { name: 'Qualify', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Qualify this lead?' })
        .getByRole('button', { name: 'Qualify lead', exact: true })
        .click();
      await expect(page.getByText('Moved to Qualified.')).toBeVisible();

      await page.getByRole('button', { name: 'Convert to opportunity' }).click();
      const dialog = page.getByRole('dialog', { name: 'Convert lead to opportunity' });
      // Keep the lead's company, contact and email, then provide the required address. The customer's
      // Country (the contact's own is "Contact country") starts at the lead's country, Nepal.
      await dialog.getByLabel('Address', { exact: true }).fill('1 Durbar Marg');
      await dialog.getByLabel('City', { exact: true }).fill('Kathmandu');
      await expect(dialog.getByRole('combobox', { name: 'Country', exact: true })).toHaveValue(
        'Nepal',
      );
      await expect(dialog.getByLabel('Email', { exact: true })).toHaveValue(email);
      await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
      await page.waitForURL(/\/opportunities\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    });

    await test.step('the board draws every stage and offers no move to a system-set stage', async () => {
      await page.goto('/opportunities?view=board');
      await expect(page.getByRole('heading', { level: 1, name: 'Opportunities' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Won' })).toContainText('Set by the system');
      await expect(page.getByRole('region', { name: 'Quotation Sent' })).toContainText(
        'Set by the system',
      );
      // The new opportunity is on the board, so at least one Move select exists to inspect.
      await expect(page.getByRole('link', { name: title })).toBeVisible();
      const selects = page.locator('input[type="hidden"][name="stage"]');
      const count = await selects.count();
      expect(count).toBeGreaterThan(0);
      // No Move select anywhere lists Won or Quotation Sent. Each card's Move control is a closed
      // <details>: open it first, then read its list.
      const options: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const move = page.locator('details > summary', { hasText: /^Move/ }).nth(i);
        await move.click();
        options.push(...(await optionLabels(selectByName(page, 'stage').nth(i))));
      }
      expect(options.some((o) => /^(Won|Quotation Sent)/.test(o))).toBe(false);
    });
  } finally {
    await context.close();
  }
});
