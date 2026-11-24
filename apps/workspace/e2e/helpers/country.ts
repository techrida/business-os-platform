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
  // A page that has not finished hydrating resets the box to its default and drops the typed text, even
  // after the list has opened, so the search is typed again until the searched option is highlighted.
  await expect(async () => {
    await box.fill('');
    await box.fill(search);
    await expect(box).toHaveAttribute('aria-expanded', 'true', { timeout: 2_000 });
    await expectHighlighted(box, shown);
  }).toPass({ timeout: 30_000 });
  await box.press('Enter');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await expect(box).toHaveValue(shown);
}

/**
 * Checks that the list's highlighted option (the one `aria-activedescendant` points at) is the searched country.
 * It does not retry: callers retype the search around it. Enter takes the highlighted option, so pressing it earlier takes whatever was highlighted before the search
 * rendered (or nothing) and the box keeps its old country.
 */
async function expectHighlighted(box: Locator, shown: string): Promise<void> {
  await expect(box).toHaveAttribute('aria-activedescendant', /./, { timeout: 2_000 });
  const id = await box.getAttribute('aria-activedescendant', { timeout: 1_000 });
  await expect(box.page().locator(`[id="${id}"][role="option"]`)).toContainText(shown, {
    ignoreCase: true,
    timeout: 2_000,
  });
}

/**
 * Picks a country in a phone row's flag menu (src/components/ui/phone-country-menu.tsx): the flag button opens a
 * searchable list; its search box is named `<button name> search`. Pass the button as
 * `getByRole('combobox', { name: 'Phone 2 country', exact: true })`. `search` must appear in the chosen country's
 * option text (its name as shown, or its dial code without spaces, e.g. `+977`): the wait before Enter compares it.
 */
export async function pickPhoneCountry(button: Locator, search: string): Promise<void> {
  const page = button.page();
  const name = (await button.getAttribute('aria-label')) ?? '';
  const box = page.getByRole('textbox', { name: `${name} search`, exact: true });
  await expect(async () => {
    await button.click();
    await expect(box).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  // The same reset can drop the typing here, so it is typed again until the searched option is highlighted.
  await expect(async () => {
    await box.fill('');
    await box.fill(search);
    await expectHighlighted(box, search);
  }).toPass({ timeout: 30_000 });
  await box.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
}
