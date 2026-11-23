'use client';
// A "pick an existing record" field (UIP-FORM-009): one search-as-you-type box over the shared Combobox, with the
// search icon inside, no Search button and no second select. No Create row: the record must already exist, and
// `noMatchText` says so. The chosen id posts under `name`. A short list is filtered here as the user types; a
// list too long to load whole passes `search`, which asks the server for the matches after typing pauses.
import { MIN_SEARCH_LENGTH } from '@bos/contracts';
import { useEffect, useMemo, useState } from 'react';

import { Combobox, type ComboboxProps } from '@/components/ui/combobox';
import { matchesQuery, type ComboboxOption } from '@/components/ui/combobox-model';
import type { FieldControlProps } from '@/components/ui/field';

/** How long typing must pause before a server search. */
export const PICK_SEARCH_DELAY_MS = 250;

/** Said in place of the no-match text when the server search was refused or did not answer. */
export const SEARCH_FAILED_TEXT = 'Search did not load. Try again.';

export type PickSearcher = (query: string, signal: AbortSignal) => Promise<ComboboxOption[]>;

/** What both modes hand the Combobox alike. */
type SharedProps = Omit<ComboboxProps, 'options' | 'value' | 'onChange' | 'name'>;

export function PickExisting({
  control,
  name,
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  noMatchText,
  required,
  disabled,
  showDescriptionWhenClosed,
  search,
  searchDelayMs = PICK_SEARCH_DELAY_MS,
}: {
  control: FieldControlProps;
  /** The form field that carries the chosen id. */
  name: string;
  options: readonly ComboboxOption[];
  value: string;
  onChange: (id: string, option?: ComboboxOption) => void;
  placeholder?: string | undefined;
  emptyText?: string | undefined;
  noMatchText: string;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  showDescriptionWhenClosed?: boolean | undefined;
  /** Where matches come from when `options` is only the first page of a longer list. */
  search?: PickSearcher | undefined;
  searchDelayMs?: number | undefined;
}) {
  const [open, setOpen] = useState(false);
  const shared: SharedProps = {
    id: control.id,
    labelledBy: control['aria-labelledby'],
    describedBy: control['aria-describedby'],
    invalid: control['aria-invalid'] === true,
    searchIcon: true,
    keepOrder: true,
    groupThreshold: 0,
    ungroupedLabel: '',
    open,
    onOpenChange: setOpen,
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(emptyText === undefined ? {} : { emptyText }),
    noMatchText,
    ...(required === undefined ? {} : { required }),
    ...(disabled === undefined ? {} : { disabled }),
  };
  if (search === undefined) {
    return (
      <Combobox
        {...shared}
        name={name}
        options={options}
        value={value}
        onChange={(id) =>
          onChange(
            id,
            options.find((o) => o.id === id),
          )
        }
        {...(showDescriptionWhenClosed === undefined ? {} : { showDescriptionWhenClosed })}
      />
    );
  }
  return (
    <SearchingPick
      shared={shared}
      name={name}
      options={options}
      value={value}
      onChange={onChange}
      search={search}
      delayMs={searchDelayMs}
    />
  );
}

/** The box owns its text (free-text mode) so the typed words can be sent to the server. */
function SearchingPick({
  shared,
  name,
  options,
  value,
  onChange,
  search,
  delayMs,
}: {
  shared: SharedProps;
  name: string;
  options: readonly ComboboxOption[];
  value: string;
  onChange: (id: string, option?: ComboboxOption) => void;
  search: PickSearcher;
  delayMs: number;
}) {
  // Every option ever shown, so the chosen one keeps its label after the list changes.
  const [known] = useState(() => new Map<string, ComboboxOption>());
  for (const o of options) known.set(o.id, o);
  const [text, setText] = useState(() => known.get(value)?.label ?? '');
  // The last answer: the matches, or `failed` when the search was refused. Either belongs to one typed text.
  const [found, setFound] = useState<{
    query: string;
    items: ComboboxOption[];
    failed: boolean;
  } | null>(null);
  const query = text.trim();

  useEffect(() => {
    // The server takes no search shorter than MIN_SEARCH_LENGTH: one letter is narrowed from the loaded list.
    if (query.length < MIN_SEARCH_LENGTH) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(query, controller.signal).then(
        (items) => {
          if (controller.signal.aborted) return;
          for (const o of items) known.set(o.id, o);
          setFound({ query, items, failed: false });
        },
        () => {
          if (!controller.signal.aborted) setFound({ query, items: [], failed: true });
        },
      );
    }, delayMs);
    // A new keystroke cancels the wait and the request in flight, so a slow old answer never lands.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, search, delayMs, known]);

  const shown = useMemo<ComboboxOption[]>(() => {
    if (query === '') return [...options];
    // Until the answer for this text arrives (or for text too short to ask), the page's own list narrowed by the same words.
    return found?.query === query ? found.items : options.filter((o) => matchesQuery(o, query));
  }, [options, found, query]);

  const failed = found?.failed === true && found.query === query;
  const noneText = failed ? SEARCH_FAILED_TEXT : shared.noMatchText;

  return (
    <>
      <Combobox
        {...shared}
        noMatchText={noneText}
        // The Combobox says "empty" when it was handed no options at all, which is what a server answer with no
        // matches is: once something is typed, that is a no-match (or a failed search), not an empty list.
        emptyText={query === '' ? shared.emptyText : noneText}
        serverFiltered
        options={shown}
        value={value}
        inputValue={text}
        onInputChange={(next) => {
          setText(next);
          // A new text starts clean: an old refusal must not label the answer to different words.
          setFound(null);
          // Editing the text after a pick means that vendor is no longer the one named.
          if (value !== '' && next !== known.get(value)?.label) onChange('');
        }}
        onChange={(id) => {
          if (id === '') {
            if (value !== '') onChange('');
            return;
          }
          const picked = known.get(id);
          if (picked !== undefined) setText(picked.label);
          onChange(id, picked);
        }}
      />
      <input type="hidden" name={name} value={value} />
    </>
  );
}
