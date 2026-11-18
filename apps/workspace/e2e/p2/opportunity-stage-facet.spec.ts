import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

async function moveStage(page: Page, value: string, label: string) {
  await page.getByLabel('Move to', { exact: true }).selectOption(value);
  if (value === 'lost') {
    await page.getByLabel('Reason', { exact: true }).fill('Customer declined');
    await page.getByLabel('Note', { exact: true }).fill('No further work planned.');
  }
  await page.getByRole('button', { name: 'Move', exact: true }).click();
  if (value === 'lost') {
    await expect(
      page.getByRole('complementary', { name: 'Stage' }).getByText(label, { exact: true }),
    ).toBeVisible();
  } else {
    await expect(page.getByText(`Moved to ${label}.`, { exact: true })).toBeVisible();
  }
}

async function createOpportunity(page: Page, name: string) {
  await page.goto('/leads/new');
  await page.getByLabel('Title').fill(name);
  await page.getByLabel('Source').selectOption('referral');
  await page.getByLabel('Company').fill(`${name} Company`);
  await page.getByLabel('Contact person').fill(name);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await moveStage(page, 'contacted', 'Contacted');
  await moveStage(page, 'qualified', 'Qualified');

  await page.getByRole('button', { name: 'Convert to opportunity', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Convert lead to opportunity' });
  await dialog.getByLabel('Address', { exact: true }).fill('Main Road');
  await dialog.getByLabel('City', { exact: true }).fill('Kathmandu');
  await dialog.getByRole('radio', { name: 'No contact' }).check();
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
    const search = page.getByRole('searchbox', { name: 'Search opportunities' });
    const trigger = page.getByRole('button', { name: /^Stage(?:,|$)/ });
    const filter = page.getByRole('dialog', { name: 'Filter by stage' });
    const first = filter.getByRole('checkbox', { name: 'Qualified', exact: true });
    const second = filter.getByRole('checkbox', { name: 'Requirement Received' });

    await page.goto('/opportunities');
    await search.fill(query);
    await page.getByRole('search').getByRole('button', { name: 'Search', exact: true }).click();
    await expect(lost).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(3);

    await trigger.press('Enter');
    await expect(first).toBeFocused();
    await first.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('q') === query &&
        url.searchParams.getAll('stage').join() === stages.join(),
    );
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    await expect(second).toBeFocused();
    await expect(trigger).toHaveAccessibleName('Stage, 2 selected');
    await expect(qualified).toBeVisible();
    await expect(requirement).toBeVisible();
    await expect(lost).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();

    await search.fill(qualifiedName);
    await search.press('Enter');
    await expect(page).toHaveURL(
      (url) =>
        url.searchParams.get('q') === qualifiedName &&
        url.searchParams.getAll('stage').join() === stages.join(),
    );
    await expect(qualified).toBeVisible();
    await expect(requirement).toHaveCount(0);
    await page.goBack();
    await expect(search).toHaveValue(query);
    await expect(requirement).toBeVisible();

    await page.getByRole('link', { name: 'Board', exact: true }).click();
    await expect(trigger).toHaveCount(0);
    await expect(search).toHaveValue(query);
    await expect(
      page.getByRole('region', { name: 'Lost' }).getByRole('link', { name: lostName }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Table', exact: true }).click();
    await expect(lost).toHaveCount(0);
    await trigger.click();
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();

    await filter.getByRole('button', { name: 'Clear stages' }).click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get('q') === query && !url.searchParams.has('stage'),
    );
    await expect(lost).toBeVisible();
    await expect(first).not.toBeChecked();
    await expect(second).not.toBeChecked();
    await page.goBack();
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    await expect(lost).toHaveCount(0);

    const params = new URLSearchParams({ q: query });
    for (const stage of [...stages, 'invalid', 'qualified']) params.append('stage', stage);
    await page.goto(`/opportunities?${params.toString()}`);
    await expect(trigger).toHaveAccessibleName('Stage, 2 selected');
    await expect(qualified).toBeVisible();
    await expect(requirement).toBeVisible();
    await expect(lost).toHaveCount(0);
  } finally {
    await context.close();
  }
});
