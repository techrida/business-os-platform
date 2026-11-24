import { expect, type Page } from '@playwright/test';

/**
 * The Create Lead form starts "Lead owner" on the signed-in user, or on the Default lead owner from Settings, or on
 * the Sales head. When the caller cannot own a lead and none of those exists, the box is empty ("No default owner is
 * set and you cannot own this lead, so choose who it goes to") and the form cannot be saved. This picks the first
 * person the list offers in that case, and leaves a filled box alone.
 */
export async function ensureLeadOwner(page: Page): Promise<void> {
  const owner = page.getByRole('combobox', { name: 'Lead owner', exact: true });
  await expect(owner).toBeVisible();
  if ((await owner.inputValue()) !== '') return;
  await owner.click();
  const first = page.getByRole('option').first();
  await expect(first, 'the Lead owner list offers someone').toBeVisible();
  await first.click();
  await expect(owner).not.toHaveValue('');
}
