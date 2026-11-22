import { expect, type Locator } from '@playwright/test';

/**
 * Picks a country in the app's CountrySelect (src/components/ui/country-select.tsx): a searchable
 * combobox where typing searches and highlights the best match and Enter takes it. Pass the box as
 * `getByRole('combobox', { name, exact: true })`, not `getByLabel`: while open, the list carries the
 * same label as the box, so a label lookup matches two elements.
 *
 * `search` is what a person types: a country code (`us`, `in`), a name, or a dial code (`+977`).
 * `shown` is the box's value once chosen: the country name, or the dial code on a phone row.
 */
export async function pickCountry(box: Locator, search: string, shown: string): Promise<void> {
  // A page that has not finished hydrating resets the box to its default and drops the typed text, so
  // the search is typed again until the list opens.
  await expect(async () => {
    await box.fill(search);
    await expect(box).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await box.press('Enter');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(box).toHaveValue(shown);
}
