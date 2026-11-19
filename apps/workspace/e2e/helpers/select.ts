import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Helpers for the app's dropdown (src/components/ui/select.tsx), which replaced the native
 * `<select>`. `locator.selectOption()` no longer works on it. The DOM is a root div holding a hidden
 * `<input name=X value=...>` (only when the field has a `name`), the trigger
 * `<button aria-haspopup="listbox">`, and, while open, a portalled `[role=listbox]` of
 * `[role=option]` items. Each option's `data-key` is its value, except the empty value, whose key is
 * `__empty__`. A `required` field leaves its `value=""` option out and shows it as the placeholder.
 */

/** `data-key` of the empty-string option. */
const EMPTY_KEY = '__empty__';

type Scope = Page | Locator;

const TRIGGER = 'button[aria-haspopup="listbox"]';

export type OptionChoice = string | { index: number } | { label: string | RegExp };

/**
 * The trigger whose label is `label`. The trigger is named by aria-labelledby (the current value
 * and the field label), so `getByLabel` matches the label on its own; a string must match the whole
 * label text.
 */
export function selectByLabel(scope: Scope, label: string | RegExp): Locator {
  return scope.locator(TRIGGER).and(scope.getByLabel(label, { exact: typeof label === 'string' }));
}

/** The trigger of the field submitted as `name`, found through its hidden input. */
export function selectByName(scope: Scope, name: string): Locator {
  return scope
    .locator(`input[type="hidden"][name="${name.replace(/(["\\])/g, '\\$1')}"]`)
    .locator('xpath=..')
    .locator(TRIGGER);
}

/** The hidden input that carries the trigger's value. Only fields with a `name` have one. */
export function selectedInput(trigger: Locator): Locator {
  return trigger.locator('xpath=..//input[@type="hidden"]');
}

/** The current value of a named field (`''` for the empty option). */
export async function selectedValue(trigger: Locator): Promise<string> {
  return selectedInput(trigger).inputValue();
}

/** False while the trigger still shows its placeholder (a required field with nothing chosen). */
export async function hasSelection(trigger: Locator): Promise<boolean> {
  return (await trigger.locator('[data-placeholder]').count()) === 0;
}

/** Opens the trigger and returns the visible list. */
async function openList(trigger: Locator): Promise<Locator> {
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const id = await trigger.getAttribute('aria-controls');
  const list = id ? trigger.page().locator(`[id="${id}"]`) : trigger.page().getByRole('listbox');
  await expect(list.getByRole('option').first()).toBeVisible();
  return list;
}

async function waitClosed(trigger: Locator, list: Locator): Promise<void> {
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
}

/** Opens `trigger`, clicks the option and waits for the list to close. */
export async function chooseOption(trigger: Locator, choice: OptionChoice): Promise<void> {
  const list = await openList(trigger);
  const options = list.getByRole('option');
  let option: Locator;
  if (typeof choice === 'string') {
    const key = (choice === '' ? EMPTY_KEY : choice).replace(/(["\\])/g, '\\$1');
    option = list.locator(`[role="option"][data-key="${key}"]`);
  } else if ('index' in choice) {
    option = options.nth(choice.index);
  } else {
    // A string matches as a substring, like `hasText`.
    option = options.filter({ hasText: choice.label }).first();
  }
  await option.click();
  await waitClosed(trigger, list);
}

/** The text of every option, read by opening the list and closing it again with Escape. */
export async function optionLabels(trigger: Locator): Promise<string[]> {
  const list = await openList(trigger);
  const labels = (await list.getByRole('option').allTextContents()).map((t) => t.trim());
  await trigger.page().keyboard.press('Escape');
  await waitClosed(trigger, list);
  return labels;
}
