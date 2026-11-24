import { expect, test, type Page } from '@playwright/test';

import { approveInboxRequest, idFromUrl, recordFixtureIds } from '../helpers/fixture-flow';
import { ensureLeadOwner } from '../helpers/lead-owner';
import { signInAs, type Signed } from '../helpers/memo-flow';
import { chooseOption, selectByName, selectByLabel } from '../helpers/select';

test.use({ actionTimeout: 30_000 });

/**
 * Warm-up step of the qa workflow ("qa fixtures": the specs skip it). The quotation specs of both apps need quotations
 * in states the product only reaches one step at a time, and the ones that act on a quotation use it up. So Sales
 * qualifies and converts one lead of Dev Customer Co into an opportunity, builds the quotations through the quote
 * builder, the Accountant approves them in the inbox, and Sales sends or rejects them. Each spec that consumes a
 * quotation takes the next one on each repeat (testInfo.repeatEachIndex), so `--repeat-each=3` has three of each.
 * The ids go to .dev/qa-fixture-ids.json for export-ids.sh. A fresh stack only: it makes new records each run.
 *
 * Not made here, because the product cannot reach them in a run: an expired quotation (the sweeper expires a version
 * only after its valid-until day passes, and Send refuses a quotation that is about to expire) and one whose PDF scan
 * is still running (the scan finishes within seconds).
 */
const REPEATS = 3;
const CONTACT_NAME = 'Dev Customer';
const CONTACT_EMAIL = 'customer@dev.bos.test';

async function makeOpportunity(page: Page): Promise<string> {
  const title = `QA fixture opportunity ${Date.now()}`;
  await page.goto('/leads/new');
  await page.waitForLoadState('networkidle');
  await page.getByRole('textbox', { name: 'Lead title', exact: true }).fill(title);
  await chooseOption(selectByName(page, 'source'), 'referral');
  const company = page.getByRole('combobox', { name: 'Company or organization', exact: true });
  await company.click();
  await company.pressSequentially('Dev Customer', { delay: 40 });
  await page
    .getByRole('option', { name: /Dev Customer Co/ })
    .first()
    .click();
  const contact = page.getByRole('combobox', { name: 'Contact person', exact: true });
  await contact.click();
  await page
    .getByRole('option', { name: new RegExp(CONTACT_NAME) })
    .first()
    .click();
  const email = page.getByRole('textbox', { name: 'Email', exact: true });
  if ((await email.inputValue()) === '') await email.fill(CONTACT_EMAIL);
  await ensureLeadOwner(page);
  await page.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await page.waitForLoadState('networkidle');

  await page.getByRole('button', { name: 'Mark contacted', exact: true }).click();
  const contacted = page.getByRole('dialog', { name: 'Mark this lead contacted?' });
  await contacted.getByRole('radio', { name: 'Call', exact: true }).click();
  await contacted.getByLabel('Note', { exact: true }).fill('Intro call');
  await contacted.getByRole('button', { name: 'Mark contacted', exact: true }).click();
  await expect(page.getByText('Moved to Contacted.')).toBeVisible();
  await page.getByRole('button', { name: 'Qualify', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Qualify this lead?' })
    .getByRole('button', { name: 'Qualify lead', exact: true })
    .click();
  await expect(page.getByText('Moved to Qualified.')).toBeVisible();

  await page.getByRole('button', { name: 'Convert to opportunity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert lead to opportunity' });
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await page.waitForURL(/\/opportunities\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return idFromUrl(page);
}

/** Builds a quotation of one line and one milestone through the quote builder; returns its id. */
async function buildQuotation(page: Page, opportunityId: string, submit: boolean): Promise<string> {
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  await page.goto(`/quotations/new?opportunityId=${opportunityId}&another=1`);
  await expect(page.getByRole('heading', { name: 'New quotation', level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add line', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add line' });
  await add.getByLabel('Description').fill('QA fixture implementation');
  await add.getByLabel('Unit', { exact: true }).fill('lot');
  await add.getByRole('spinbutton', { name: 'Quantity' }).fill('1');
  await add.getByRole('textbox', { name: /^Rate \(/ }).fill('50000');
  await chooseOption(selectByLabel(add, 'Tax code'), { index: 0 });
  await add.getByRole('button', { name: 'Add line', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Quotation lines' })).toContainText(
    'QA fixture implementation',
  );
  await save.click();
  await expect(page).toHaveURL(/\/quotations\/[^/]+\/edit\?saved=1/);
  const id = idFromUrl(page);
  if (!submit) return id;

  await page.goto(`/quotations/${id}/edit`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add milestone' }).click();
  await page.getByLabel('Milestone 1', { exact: true }).fill('Advance');
  await page.getByRole('spinbutton', { name: 'Percent (%)' }).fill('100');
  const due = page.getByRole('group', { name: 'Due when' }).first();
  for (const [segment, digits] of [
    ['year', '2030'],
    ['month', '06'],
    ['day', '15'],
  ] as const) {
    await due.locator(`[data-type="${segment}"]`).pressSequentially(digits);
  }
  await save.click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for approval', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Submit this quotation for approval?' })
    .getByRole('button', { name: 'Submit quotation' })
    .click();
  await expect(page).toHaveURL(/\/quotations\/[^/]+\/edit\?submitted=1/);
  await expect(page.getByText('Approval pending', { exact: true })).toBeVisible();
  return id;
}

/** Sends an approved quotation to the seeded contact, once its PDF is clean. */
async function sendQuotation(page: Page, id: string): Promise<void> {
  await page.goto(`/quotations/${id}`);
  const trigger = page.getByRole('button', { name: 'Send to customer' });
  await expect(async () => {
    await page.reload();
    await expect(trigger).toBeVisible({ timeout: 3_000 });
    await expect(trigger).not.toHaveAttribute('aria-disabled', 'true', { timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /^Send / });
  // The dialog starts on the quotation's own contact.
  await expect(dialog.getByRole('combobox', { name: 'Send to', exact: true })).toHaveValue(
    CONTACT_NAME,
  );
  await dialog.locator('footer').getByRole('button', { name: 'Send to customer' }).click();
  await expect(dialog.getByText('Sent to').first()).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
}

/** The customer says no: the quotation can then be revised. */
async function rejectQuotation(page: Page, id: string): Promise<void> {
  await page.goto(`/quotations/${id}`);
  await page.getByRole('button', { name: 'Record outcome' }).click();
  const dialog = page.getByRole('dialog', { name: /^Record the outcome of / });
  await dialog.getByLabel('Rejected').check();
  await dialog.getByLabel('Signed quotation').uncheck();
  await dialog.getByLabel('Comment').fill('QA fixture: the customer declined.');
  await dialog.getByRole('button', { name: 'Record outcome' }).click();
  await expect(dialog.getByText('Recorded as rejected').first()).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
}

test('qa fixtures: quotations for the portal and the quotation screens', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(2_400_000);
  const base = baseURL ?? 'https://app.localhost';
  const opened: Signed[] = [];
  const as = async (key: string): Promise<Page> => {
    const signed = await signInAs(browser, base, key);
    opened.push(signed);
    return signed.page;
  };
  const make = {
    portalSent: [] as string[],
    staffSent: [] as string[],
    revisable: [] as string[],
    approved: [] as string[],
  };
  let opportunityId = '';
  let draftId = '';
  try {
    await test.step('Sales converts a lead of Dev Customer Co and builds the quotations', async () => {
      const sales = await as('sales');
      opportunityId = await makeOpportunity(sales);
      for (const kind of Object.keys(make) as (keyof typeof make)[]) {
        for (let i = 0; i < REPEATS; i += 1) {
          make[kind].push(await buildQuotation(sales, opportunityId, true));
        }
      }
      draftId = await buildQuotation(sales, opportunityId, false);
    });
    await test.step('the Accountant and then Finance approve each in the inbox', async () => {
      const accountant = await as('accountant');
      const finance = await as('finance');
      for (let i = 0; i < REPEATS * Object.keys(make).length; i += 1) {
        await approveInboxRequest(accountant, /Quotation/i, 'QA fixture: priced and checked');
      }
      for (let i = 0; i < REPEATS * Object.keys(make).length; i += 1) {
        await approveInboxRequest(finance, /Quotation/i, 'QA fixture: approved');
      }
    });
    await test.step('Sales sends the ones the customer sees and rejects the revisable ones', async () => {
      const sales = await as('sales');
      for (const id of [...make.portalSent, ...make.staffSent, ...make.revisable]) {
        await sendQuotation(sales, id);
      }
      for (const id of make.revisable) await rejectQuotation(sales, id);
    });
    recordFixtureIds({
      opportunity: opportunityId,
      quotationPortalSent: make.portalSent,
      quotationStaffSent: make.staffSent,
      quotationRevisable: make.revisable,
      quotationApproved: make.approved,
      quotationDraft: draftId,
    });
  } finally {
    await Promise.all(opened.map((s) => s.context.close()));
  }
});
