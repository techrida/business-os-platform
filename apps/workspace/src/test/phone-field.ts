import { act } from 'react';

import { countryFlag } from '@/components/ui/country-data';

import { click, typeKeys } from './form-interactions';

/** The flag button of a phone row: `Phone N country` (the one-box phone field's country menu). */
export const phoneCountryButton = (root: ParentNode, n: number) =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="Phone ${n} country"]`);

/** The flag a phone row shows. */
export const phoneFlag = (root: ParentNode, n: number) =>
  phoneCountryButton(root, n)?.textContent ?? null;

export { countryFlag };

/** Picks a country in a phone row's flag menu: open it, type in its search box, press Enter. */
export async function pickPhoneCountry(button: HTMLButtonElement, search: string) {
  await click(button);
  const label = button.getAttribute('aria-label')!;
  const box = document.querySelector<HTMLInputElement>(`input[aria-label="${label} search"]`)!;
  await typeKeys(box, search);
  await act(() =>
    Promise.resolve(
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    ),
  );
}
