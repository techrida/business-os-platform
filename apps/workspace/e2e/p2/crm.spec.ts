import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

/**
 * The CRM screens against the real stack, as the sales persona: create a lead, log a call, move
 * it with the keyboard control, see the board, and check that system-only stages are never
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
      await page
        .getByRole('combobox', { name: 'Lead source', exact: true })
        .selectOption('referral');
      await page
        .getByRole('textbox', { name: 'Company or organization', exact: true })
        .fill('Binford Ltd.');
      await page.getByLabel('Contact person').fill('Sunita Shrestha');
      await page.getByRole('button', { name: 'Save lead' }).click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    });

    await test.step('a refused form keeps what was typed and names the field', async () => {
      await page.goto('/leads/new');
      await page.getByRole('textbox', { name: 'Lead title', exact: true }).fill('Half a lead');
      await page.getByRole('button', { name: 'Save lead' }).click();
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

    await test.step('move to Contacted with the select, no mouse drag', async () => {
      await page.getByLabel('Move to').selectOption('contacted');
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect(page.getByText('Moved to Contacted.')).toBeVisible();
    });

    await test.step('Lost needs a reason and a note', async () => {
      await page.getByLabel('Move to').selectOption('lost');
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect(page.getByText('Give a reason, up to 200 characters.')).toBeVisible();
      await expect(
        page.getByText('Add a note for the record, up to 2,000 characters.'),
      ).toBeVisible();
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
  try {
    await test.step('convert a qualified lead into an opportunity', async () => {
      await page.goto('/leads/new');
      await page.waitForLoadState('networkidle');
      await page.getByLabel('Title').fill(title);
      await page.getByLabel('Source').selectOption('referral');
      await page.getByLabel('Company').fill(`Board Test ${stamp} Pvt. Ltd.`);
      await page.getByLabel('Contact person').fill(`Board Tester ${stamp}`);
      await page.getByRole('button', { name: 'Save lead' }).click();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await page.waitForLoadState('networkidle');

      // A lead must be Qualified before it can be converted: New, Contacted, Qualified.
      await page.getByLabel('Move to').selectOption('contacted');
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect(page.getByText('Moved to Contacted.')).toBeVisible();
      await page.getByLabel('Move to').selectOption('qualified');
      await page.getByRole('button', { name: 'Move', exact: true }).click();
      await expect(page.getByText('Moved to Qualified.')).toBeVisible();

      await page.getByRole('button', { name: 'Convert to opportunity' }).click();
      const dialog = page.getByRole('dialog', { name: 'Convert lead to opportunity' });
      // The dialog starts from the lead's company and contact; the address is the one thing it cannot know.
      await dialog.getByLabel('Address', { exact: true }).fill('1 Durbar Marg');
      await dialog.getByLabel('City', { exact: true }).fill('Kathmandu');
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
      const selects = page.locator('select[name="stage"]');
      expect(await selects.count()).toBeGreaterThan(0);
      // No Move select anywhere lists Won or Quotation Sent.
      const options = await page.locator('select[name="stage"] option').allTextContents();
      expect(options.some((o) => /^(Won|Quotation Sent)/.test(o))).toBe(false);
    });
  } finally {
    await context.close();
  }
});
