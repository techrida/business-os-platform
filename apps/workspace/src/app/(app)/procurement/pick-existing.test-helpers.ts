import { fill, click } from '@/test/form-interactions';

/** The search box of the PickExisting field that posts `name`. */
export function pickBox(container: HTMLElement, name: string): HTMLInputElement {
  const hidden = container.querySelector(`input[type="hidden"][name="${name}"]`);
  const box = hidden?.parentElement?.querySelector<HTMLInputElement>('input[role="combobox"]');
  if (!box) throw new Error(`No picker named ${name}`);
  return box;
}

/** The visible text of every option in the open list. */
export const listedOptions = (): string[] =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim() ?? '');

/** Type into the picker (no button pressed) and click the option whose text starts with `option`. */
export async function pickByTyping(
  container: HTMLElement,
  name: string,
  typed: string,
  option: string,
) {
  await fill(pickBox(container, name), typed);
  const found = Array.from(document.querySelectorAll('[role="option"]')).find((el) =>
    (el.textContent ?? '').trim().startsWith(option),
  );
  if (!found) throw new Error(`No option "${option}" for "${typed}" in ${name}`);
  await click(found);
}
