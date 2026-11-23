import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';
import {
  clearSelection,
  expectSelected,
  multiSelectByLabel,
  searchBox,
  toggleOptions,
} from '../helpers/multi-select';
import { chooseOption, selectByName } from '../helpers/select';
import { ensureLeadOwner } from '../helpers/lead-owner';

async function moveStage(page: Page, value: string, label: string) {
  if (value === 'contacted') {
    // New to Contacted needs the call, email or meeting that made the contact (D48).
    await page.getByRole('button', { name: 'Mark contacted', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark this lead contacted?' });
    await dialog.getByRole('radio', { name: 'Call', exact: true }).click();
    await dialog.getByLabel('Note', { exact: true }).fill('Intro call');
    await dialog.getByRole('button', { name: 'Mark contacted', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Moved to ${label}.`, { exact: true })).toBeVisible();
    return;
  }
  if (value === 'lost') {
    // Lost is marked from the header dialog, with a reason chosen from the tenant list (D49, D54-3).
    await page.getByRole('button', { name: 'Mark lost', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark this opportunity lost?' });
    await dialog.getByRole('combobox', { name: 'Reason' }).click();
    await page.getByRole('option', { name: 'Price', exact: true }).click();
    await dialog.getByLabel('Note', { exact: true }).fill('No further work planned.');
    await dialog.getByRole('button', { name: 'Mark lost', exact: true }).click();
    await expect(
      page.getByRole('complementary', { name: 'Stage' }).getByText(label, { exact: true }),
    ).toBeVisible();
    return;
  }
  if (value === 'requirement_received') {
    // The deal page has no stage select: its primary move is a button that opens a confirm dialog.
    await page.getByRole('button', { name: 'Requirement received', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark requirement received?' });
    await dialog.getByRole('button', { name: 'Move to Requirement Received', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(`Moved to ${label}.`, { exact: true })).toBeVisible();
    return;
  }
  await chooseOption(selectByName(page, 'stage'), value);
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(page.getByText(`Moved to ${label}.`, { exact: true })).toBeVisible();
}

async function createOpportunity(page: Page, name: string) {
  await page.goto('/leads/new');
  await page.getByRole('textbox', { name: 'Lead title', exact: true }).fill(name);
  await chooseOption(selectByName(page, 'source'), 'referral');
  await page
    .getByRole('textbox', { name: 'Company or organization', exact: true })
    .fill(`${name} Company`);
  await page.getByLabel('Contact person').fill(name);
  // A lead needs an email or at least one phone number.
  await page
    .getByRole('textbox', { name: 'Email', exact: true })
    .fill(`${randomUUID()}@example.test`);
  await ensureLeadOwner(page);
  await page.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await moveStage(page, 'contacted', 'Contacted');
  await page.getByRole('button', { name: 'Qualify', exact: true }).click();
  const qualification = page.getByRole('dialog', { name: 'Qualify this lead?' });
  await qualification.getByRole('button', { name: 'Qualify lead', exact: true }).click();
  await expect(qualification).toBeHidden();
  await expect(page.getByText('Moved to Qualified.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Convert to opportunity', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert lead to opportunity' });
  await dialog.getByLabel('Address', { exact: true }).fill('Main Road');
  await dialog.getByLabel('City', { exact: true }).fill('Kathmandu');
  // A conversion always names a contact with an email (there is no "No contact" any more).
  await dialog.getByLabel('Email', { exact: true }).fill(`${randomUUID()}@example.test`);
  await dialog.getByRole('button', { name: 'Convert', exact: true }).click();
  await expect(page).toHaveURL(/\/opportunities\/[\da-f-]+$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

test('the opportunity table combines multiple stages with search and restores filters from history', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');
  const query = `Stage facet & ${randomUUID()}`;
  const qualifiedName = `${query} First`;
  const requirementName = `${query} Second`;
  const lostName = `${query} Third`;

  try {
    await createOpportunity(page, qualifiedName);
    await createOpportunity(page, requirementName);
    await moveStage(page, 'requirement_received', 'Requirement Received');
    await createOpportunity(page, lostName);
    await moveStage(page, 'lost', 'Lost');

    const stages = ['qualified', 'requirement_received'];
    const table = page.getByRole('table', { name: 'Opportunities' });
    const qualified = table.getByRole('link', { name: qualifiedName });
    const requirement = table.getByRole('link', { name: requirementName });
    const lost = table.getByRole('link', { name: lostName });
    const search = searchBox(page, 'Search opportunities');
    const stage = multiSelectByLabel(page, 'Stage');
    // The URL is the state: `q` plus one repeated `stage` param per selected stage.
    const expectUrl = (q: string, values: readonly string[]) =>
      expect(page).toHaveURL(
        (url) =>
          url.searchParams.get('q') === q &&
          url.searchParams.getAll('stage').sort().join() === [...values].sort().join(),
      );

    await page.goto('/opportunities');
    await search.fill(query);
    await expectUrl(query, []);
    await expect(qualified).toBeVisible();
    await expect(requirement).toBeVisible();
    await expect(lost).toBeVisible();

    await toggleOptions(stage, stages);
    await expectUrl(query, stages);
    await expectSelected(stage, stages);
    await expect(stage).toContainText('2 stages');
    await expect(qualified).toBeVisible();
    await expect(requirement).toBeVisible();
    await expect(lost).toHaveCount(0);

    // A search replaces its history entry; each stage change is its own entry.
    await search.fill(qualifiedName);
    await expectUrl(qualifiedName, stages);
    await expect(qualified).toBeVisible();
    // Exact hits come first; close matches may follow, so the other rows are not asserted absent.
    await expect(table.locator('tbody tr').first()).toContainText(qualifiedName);
    await expect(lost).toHaveCount(0);
    await page.goBack();
    await expectUrl(query, ['qualified']);
    await expect(search).toHaveValue(query);
    await expectSelected(stage, ['qualified']);
    await expect(stage).toContainText('Qualified');
    await expect(qualified).toBeVisible();
    await expect(requirement).toHaveCount(0);
    await page.goForward();
    await expectUrl(qualifiedName, stages);
    await expect(search).toHaveValue(qualifiedName);
    await search.fill(query);
    await expectUrl(query, stages);
    await expect(requirement).toBeVisible();

    await page.getByRole('link', { name: 'Board', exact: true }).click();
    await expect(stage).toHaveCount(0);
    await expect(search).toHaveValue(query);
    await expect(
      page.getByRole('region', { name: 'Lost' }).getByRole('link', { name: lostName }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Table', exact: true }).click();
    await expect(lost).toHaveCount(0);
    await expectSelected(stage, stages);

    await clearSelection(stage);
    await expectUrl(query, []);
    await expect(lost).toBeVisible();
    await expectSelected(stage, []);
    await page.goBack();
    await expectUrl(query, stages);
    await expectSelected(stage, stages);
    await expect(lost).toHaveCount(0);

    // Hand-edited params: unknown values are dropped and repeats collapse.
    const params = new URLSearchParams({ q: query });
    for (const value of [...stages, 'invalid', 'qualified']) params.append('stage', value);
    await page.goto(`/opportunities?${params.toString()}`);
    await expectSelected(stage, stages);
    await expect(stage).toContainText('2 stages');
    await expect(qualified).toBeVisible();
    await expect(requirement).toBeVisible();
    await expect(lost).toHaveCount(0);
  } finally {
    await context.close();
  }
});
