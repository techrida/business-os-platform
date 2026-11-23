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
const fold = (value: string): string => value.normalize('NFC').toLowerCase();

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
  keepOrder = false,
): OptionLayout {
  const matching = options.filter((option) => matchesQuery(option, query));
  // A list with its own meaningful order (a tenant's lost reasons) keeps it; the default is by name.
  const visible = keepOrder
    ? matching
    : matching.sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id));
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
  // A list with its own order (the caller's relevance order) also keeps its groups in the order they first appear;
  // the ungrouped options (such as the Create row) always come last.
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) =>
      a === ungroupedLabel ? 1 : b === ungroupedLabel ? -1 : keepOrder ? 0 : collator.compare(a, b),
    )
    .map(([label, members]) => ({ key: label, label, options: members }));
  return { grouped, groups, flat: groups.flatMap((g) => g.options) };
}

/** The id of the "Add ..." row a combobox with `addOption` shows when the typed text matches no option. */
export const ADD_OPTION_ID = '__add__';

/**
 * The row that offers to add what was typed: null while the box is empty or an option already has exactly those
 * words (trimmed, case-insensitive), so the same text is never offered as new next to the option it duplicates.
 * `always` keeps the row even then (a company field where the typed name may match a customer and still be new).
 */
export function addOptionFor(
  options: readonly ComboboxOption[],
  query: string,
  makeLabel: (text: string) => string,
  always = false,
): ComboboxOption | null {
  const text = query.trim();
  if (text === '') return null;
  const wanted = fold(text);
  if (!always && options.some((o) => fold(o.label.trim()) === wanted)) return null;
  return { id: ADD_OPTION_ID, label: makeLabel(text), searchText: text };
}

/** The ids the keyboard can land on: enabled options, in display order. */
export const selectableIds = (flat: readonly ComboboxOption[]): string[] =>
  flat.filter((o) => o.disabled !== true).map((o) => o.id);

/** ArrowDown / ArrowUp / Home / End over the selectable ids. Arrows wrap at both ends; from no active option, Down/Home goes first and Up/End goes last. */
export function moveActive(
  ids: readonly string[],
  activeId: string | null,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End',
): string | null {
  if (ids.length === 0) return null;
  if (key === 'Home') return ids[0]!;
  if (key === 'End') return ids[ids.length - 1]!;
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
