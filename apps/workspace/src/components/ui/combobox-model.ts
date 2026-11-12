// The pure part of the Combobox: which options match a query, how they are grouped, and how the arrow keys move.
// No React and no DOM, so every rule here is unit-tested. The component only wires events to these functions.

export interface ComboboxOption {
  id: string;
  /** What the input shows once the option is chosen. */
  label: string;
  /** Small text after the label in the list (a job title, a department). */
  description?: string | undefined;
  /** The heading this option sits under when the list is grouped; null or missing means "no group". */
  group?: string | null | undefined;
  /** Extra words that should match a search but are not shown. */
  searchText?: string | undefined;
  /** Shown but not selectable (already chosen elsewhere). */
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

export interface OptionGroup {
  key: string;
  /** Null for the single flat group. */
  label: string | null;
  options: ComboboxOption[];
}

export interface OptionLayout {
  grouped: boolean;
  groups: OptionGroup[];
  /** Every visible option in display order (disabled ones included). */
  flat: ComboboxOption[];
}

export const DEFAULT_GROUP_THRESHOLD = 20;
export const UNGROUPED_LABEL = 'Unassigned';

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Lower-cased, composed form used for matching, so "José" typed either way finds "José". */
const fold = (value: string): string => value.normalize('NFC').toLocaleLowerCase();

/** Every whitespace-separated word of the query must appear somewhere in the option's text. */
export function matchesQuery(option: ComboboxOption, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fold(
    [option.label, option.description, option.group, option.searchText]
      .filter((part): part is string => typeof part === 'string')
      .join(' '),
  );
  return words.every((word) => haystack.includes(word));
}

/**
 * Filters, sorts and (when the full list is longer than `groupThreshold`) groups the options by their real group.
 * The decision to group uses the whole list, not the filtered one, so the list does not change shape while typing.
 */
export function layoutOptions(
  options: readonly ComboboxOption[],
  query: string,
  groupThreshold: number = DEFAULT_GROUP_THRESHOLD,
  ungroupedLabel: string = UNGROUPED_LABEL,
): OptionLayout {
  const visible = options
    .filter((option) => matchesQuery(option, query))
    .sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id));
  const grouped = options.length > groupThreshold;
  if (!grouped) {
    return {
      grouped,
      groups: visible.length === 0 ? [] : [{ key: '', label: null, options: visible }],
      flat: visible,
    };
  }
  const byGroup = new Map<string, ComboboxOption[]>();
  for (const option of visible) {
    const label = option.group?.trim() ? option.group.trim() : ungroupedLabel;
    byGroup.set(label, [...(byGroup.get(label) ?? []), option]);
  }
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) =>
      a === ungroupedLabel ? 1 : b === ungroupedLabel ? -1 : collator.compare(a, b),
    )
    .map(([label, members]) => ({ key: label, label, options: members }));
  return { grouped, groups, flat: groups.flatMap((g) => g.options) };
}

/** The ids the keyboard can land on: enabled options, in display order. */
export const selectableIds = (flat: readonly ComboboxOption[]): string[] =>
  flat.filter((o) => o.disabled !== true).map((o) => o.id);

/** ArrowDown / ArrowUp over the selectable ids, wrapping at both ends. From no active option, Down goes first and Up goes last. */
export function moveActive(
  ids: readonly string[],
  activeId: string | null,
  key: 'ArrowDown' | 'ArrowUp',
): string | null {
  if (ids.length === 0) return null;
  const index = activeId === null ? -1 : ids.indexOf(activeId);
  if (index === -1) return key === 'ArrowDown' ? ids[0]! : ids[ids.length - 1]!;
  const step = key === 'ArrowDown' ? 1 : -1;
  return ids[(index + step + ids.length) % ids.length]!;
}

/** The status sentence a screen reader hears while the list is open. */
export function resultsAnnouncement(
  count: number,
  totalOptions: number,
  texts: { empty: string; noMatch: string },
): string {
  if (totalOptions === 0) return texts.empty;
  if (count === 0) return texts.noMatch;
  return count === 1 ? '1 result available' : `${count} results available`;
}
