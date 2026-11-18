import { expect, test } from '@playwright/test';

import { signInAs } from '../helpers/memo-flow';

/** Requires a qualified E2E_OPPORTUNITY_ID and the quotation workflow and tax codes in the P2 stack. */
const opportunityId = process.env['E2E_OPPORTUNITY_ID'];

test('save, reopen, edit, price and submit a quotation', async ({ browser, baseURL }) => {
  test.skip(!opportunityId, 'Set E2E_OPPORTUNITY_ID to a seeded opportunity id.');
  test.setTimeout(180_000);
  const { page } = await signInAs(browser, baseURL ?? 'https://app.localhost', 'sales');

  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  const submit = page.getByRole('button', { name: 'Submit for approval', exact: true });
  const lines = page.getByRole('table', { name: 'Quotation lines' });
  const totals = page.getByRole('complementary', { name: 'Totals' });
  const add = page.getByRole('dialog', { name: 'Add line' });
  const edit = page.getByRole('dialog', { name: 'Edit line' });
  const percent = page.getByRole('spinbutton', { name: 'Percent (%)' });
  const amount = page.getByRole('spinbutton', { name: /^Amount \(/ });

  await test.step('add a typed line and save the draft', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/quotations/new?opportunityId=${opportunityId}`);
    await expect(page.getByRole('heading', { name: 'New quotation', level: 1 })).toBeVisible();
    await expect(totals.getByText('Save the draft to see the totals.')).toBeVisible();
    await expect(submit).toHaveCount(0);
    await expect(save).toHaveCount(1);
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await add.getByLabel('Description').fill('HRMS implementation');
    await add.getByLabel('Unit', { exact: true }).fill('lot');
    await add.getByRole('spinbutton', { name: 'Quantity' }).fill('1');
    await add.getByRole('spinbutton', { name: /^Rate \(/ }).fill('200000');
    await add.getByLabel('Tax code').selectOption({ index: 1 });
    await add.getByRole('button', { name: 'Add line', exact: true }).click();
    await expect(lines.getByText('HRMS implementation')).toBeVisible();
    await save.click();
    await expect(page).toHaveURL(/\/quotations\/[^/]+\/edit\?saved=1/);
    await expect(page.getByText('Draft saved.', { exact: true })).toBeVisible();
  });

  await test.step('reopen a saved line, cancel changes, then save a real edit', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const editFirst = page.getByRole('button', { name: /^Edit line 1:/ });
    await editFirst.click();
    await expect(edit.getByLabel('Description')).toHaveValue('HRMS implementation');
    await expect(edit.getByRole('spinbutton', { name: 'Quantity' })).toHaveValue(/^1(?:\.0+)?$/);
    await edit.getByLabel('Description').fill('Discard this change');
    await page.keyboard.press('Escape');
    await expect(edit).toBeHidden();
    await expect(editFirst).toBeFocused();
    await expect(lines.getByText('HRMS implementation')).toBeVisible();
    await expect(page.getByText('All changes saved')).toBeVisible();

    await editFirst.click();
    await edit.getByLabel('Description').fill('HRMS implementation and training');
    await edit.getByRole('button', { name: 'Save line' }).click();
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await save.click();
    await expect(page.getByText('All changes saved')).toBeVisible();

    await page.goto(page.url().split('?')[0]!);
    await expect(
      lines.getByText('HRMS implementation and training', { exact: true }),
    ).toBeVisible();
    await expect(totals.getByText('Total', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Approval requirements' })).toBeVisible();
    await expect(page.getByText('Any accountant', { exact: true })).toBeVisible();
    await expect(save).toHaveCount(1);
    await expect(submit).toHaveCount(1);
  });

  await test.step('link the amount to the ready total and validate on attempted save or submit', async () => {
    await page.getByRole('button', { name: 'Add milestone' }).click();
    await page.getByLabel('Milestone 1', { exact: true }).fill('Advance');
    await percent.fill('100');
    await expect(amount).toHaveValue(/^[1-9]\d*\.\d{2}$/);
    const fullAmount = await amount.inputValue();
    await percent.fill('60');
    await expect(amount).not.toHaveValue(fullAmount);
    await expect(page.getByText('60.00% / 100% allocated')).toBeVisible();

    await submit.click();
    await expect(page.getByText(/The payment schedule must add up to 100%/)).toBeVisible();
    await expect(percent).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('dialog', { name: /Submit this quotation/ })).toBeHidden();
    await save.click();
    await expect(page.getByText(/The payment schedule must add up to 100%/)).toBeVisible();

    await amount.fill('1.23');
    await expect(page.getByText(/This amount needs more than two decimal places/)).toBeVisible();
    await expect(percent).toHaveValue('60');
    await amount.press('Escape');
    await expect(amount).not.toHaveAttribute('aria-invalid', 'true');

    await amount.fill('9999999999999999');
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    await expect(percent).toHaveValue('60');
    await amount.fill(fullAmount);
    await expect(percent).toHaveValue('100.00');
    await expect(percent).not.toHaveAttribute('aria-invalid', 'true');
  });

  await test.step('changing the issue date clears an invalid draft amount and allows saving', async () => {
    await amount.fill('9999999999999999');
    await expect(amount).toHaveAttribute('aria-invalid', 'true');
    const issueDate = page.getByLabel('Issue date');
    const priorDay = new Date(await issueDate.inputValue());
    priorDay.setUTCDate(priorDay.getUTCDate() - 1);
    await issueDate.fill(priorDay.toISOString().slice(0, 10));
    await expect(amount).toBeDisabled();
    await expect(percent).toHaveValue('100.00');
    await save.click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(amount).toBeEnabled();
  });

  await test.step('refresh server pricing, save, cancel submission, then confirm', async () => {
    await page.getByLabel('Discount type').selectOption('pct');
    await page.getByLabel('Discount (%)').fill('15');
    await expect(page.getByText('Amount unavailable until pricing is ready.')).toBeVisible();
    await expect(page.getByText('This discount needs approval')).toBeVisible();
    await expect(amount).not.toHaveValue('');
    await expect(amount).toBeEnabled();
    await expect(percent).toHaveValue('100.00');
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
    await page.reload();
    for (const [segment, digits] of [
      ['year', '2030'],
      ['month', '6'],
      ['day', '15'],
    ] as const) {
      await expect(due.locator(`[data-type="${segment}"]`)).toHaveText(new RegExp(`^0?${digits}$`));
    }

    await submit.click();
    const confirmation = page.getByRole('dialog', { name: 'Submit this quotation for approval?' });
    await expect(confirmation.getByText('Any accountant')).toBeVisible();
    await confirmation.getByRole('button', { name: 'Keep editing' }).click();
    await expect(confirmation).toBeHidden();
    await expect(submit).toBeFocused();

    await submit.click();
    await confirmation.getByRole('button', { name: 'Submit quotation' }).click();
    await expect(page).toHaveURL(/\/quotations\/[^/]+\/edit\?submitted=1/);
    await expect(page.getByText('Approval pending', { exact: true })).toBeVisible();
  });
});
