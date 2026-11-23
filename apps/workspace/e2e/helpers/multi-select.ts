import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Helpers for the list filters (src/components/ui/{multi-select,filter-bar}.tsx). Filters apply as
 * soon as they change and live in the URL as repeated params (`?status=a&status=b`); there is no
 * Apply, Search or Show button. A MultiSelect is a trigger `<button aria-haspopup="listbox">` named
 * by the filter's label ("Status"). Its popover holds a `[role=listbox]` of `[role=option]` items
 * (`aria-selected` is the checkbox state, `data-key` is the value) that stays open while toggling,
 * and a "Clear" button. Hidden `<input name=X value=...>`s exist only for the values that are on, so
 * an empty filter has none: find the trigger by label, never by `selectByName`.
 */

type Scope = Page | Locator;

/** A value (the option's `data-key`, such as `cancelled`) or a visible label. */
export type MultiOption = string | { label: string };

/** The filter dropdown named `label` (exact), for example `multiSelectByLabel(page, 'Status')`. */
export function multiSelectByLabel(scope: Scope, label: string): Locator {
  // The trigger is named by its value and then its label ("All stages Stage"), and `getByLabel` does not
  // match that joined name on the label alone, so the name is matched by its last words.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return scope
    .locator('button[aria-haspopup="listbox"]')
    .and(scope.getByRole('button', { name: new RegExp(`(^|\\s)${escaped}$`) }));
}

/** The instant search box of a list, found by the label its toolbar gives it. */
export function searchBox(page: Page, label: string): Locator {
  return page.getByRole('searchbox', { name: label, exact: true });
}

/** Every value of `name` in the current URL, in URL order. */
export function paramValues(page: Page, name: string): string[] {
  return new URL(page.url()).searchParams.getAll(name);
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/**
 * Waits until the URL carries exactly `values` for `name` (any order; `[]` means the param is
 * absent). Navigation after a change is asynchronous, so this retries.
 */
export async function expectParam(
  page: Page,
  name: string,
  values: readonly string[],
): Promise<void> {
  await expect(page).toHaveURL((url) => sameSet(url.searchParams.getAll(name), values));
}

/** The values that are on, read from the hidden inputs the control renders, in option order. */
export async function selectedValues(trigger: Locator): Promise<string[]> {
  return trigger
    .locator('xpath=..')
    .locator('input[type="hidden"]')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
}

/** Retries until the control shows exactly `values` (any order; `[]` for "all"). */
export async function expectSelected(trigger: Locator, values: readonly string[]): Promise<void> {
  await expect
    .poll(async () => [...(await selectedValues(trigger))].sort().join('\u0000'))
    .toBe([...values].sort().join('\u0000'));
}

/** Opens the list, unless it is already open, and returns it. */
async function openList(trigger: Locator): Promise<Locator> {
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const id = await trigger.getAttribute('aria-controls');
  const list = id ? trigger.page().locator(`[id="${id}"]`) : trigger.page().getByRole('listbox');
  await expect(list.getByRole('option').first()).toBeVisible();
  return list;
}

async function closeList(trigger: Locator, list: Locator): Promise<void> {
  if ((await trigger.getAttribute('aria-expanded')) === 'true') {
    await trigger.page().keyboard.press('Escape');
  }
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(list).toBeHidden();
}

function optionFor(list: Locator, choice: MultiOption): Locator {
  if (typeof choice === 'string') {
    return list.locator(`[role="option"][data-key="${choice.replace(/(["\\])/g, '\\$1')}"]`);
  }
  return list.getByRole('option', { name: choice.label, exact: true });
}

/**
 * Opens `trigger`, toggles each option in turn (a checked one is switched off), then closes the
 * list with Escape. The list stays open between clicks, as in the app; every toggle changes the
 * URL on its own.
 */
export async function toggleOptions(
  trigger: Locator,
  choices: readonly MultiOption[],
): Promise<void> {
  const list = await openList(trigger);
  for (const choice of choices) {
    const option = optionFor(list, choice);
    const wasOn = (await option.getAttribute('aria-selected')) === 'true';
    await option.click();
    await expect(option).toHaveAttribute('aria-selected', wasOn ? 'false' : 'true');
  }
  await closeList(trigger, list);
}

/** The options that are on (by `data-key`), read by opening the list and closing it again. */
export async function selectedOptionKeys(trigger: Locator): Promise<string[]> {
  const list = await openList(trigger);
  const keys = await list
    .locator('[role="option"][aria-selected="true"]')
    .evaluateAll((options) => options.map((o) => o.getAttribute('data-key') ?? ''));
  await closeList(trigger, list);
  return keys;
}

/** Opens `trigger` and presses its Clear button, which empties the filter and closes the list. */
export async function clearSelection(trigger: Locator): Promise<void> {
  await openList(trigger);
  // The open popover hides the rest of the page from the accessibility tree, so this is the one.
  await trigger.page().getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
}
