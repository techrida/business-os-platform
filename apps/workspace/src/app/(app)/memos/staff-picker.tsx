'use client';
import type { MemoDirectory } from '@bos/contracts';
import { useMemo, type Ref } from 'react';

import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';

/** More staff than this and the list is grouped by their real directory department. */
export const STAFF_GROUPING_THRESHOLD = 20;

type Person = MemoDirectory['people'][number];

/**
 * Turns the directory into combobox options. Two people can share a name, so a duplicate shows its title (or, with
 * none, a short reference) in the box once chosen, and is never told apart by name alone.
 */
export function staffOptions(
  people: readonly Person[],
  opts: { disabledIds?: ReadonlySet<string>; grouped?: boolean } = {},
): ComboboxOption[] {
  const counts = new Map<string, number>();
  for (const p of people) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const grouped = opts.grouped ?? people.length > STAFF_GROUPING_THRESHOLD;
  return people.map((p) => {
    const duplicate = (counts.get(p.name) ?? 0) > 1;
    const disabled = opts.disabledIds?.has(p.userId) === true;
    return {
      id: p.userId,
      label: duplicate ? `${p.name} (${p.jobTitle ?? `ref ${p.userId.slice(-8)}`})` : p.name,
      // In a grouped list the department is the heading; in a flat one it is part of the line.
      description:
        [p.jobTitle, grouped ? null : p.department].filter(Boolean).join(' · ') || undefined,
      group: p.department,
      disabled: disabled || undefined,
      disabledReason: disabled ? 'Already chosen' : undefined,
    };
  });
}

/**
 * One staff field: the box you click is the box you type in, the matching people list under it. A thin adapter
 * over the shared Combobox; every behaviour (keyboard, grouping, empty and no-match) lives there.
 */
export function StaffPicker({
  label,
  people,
  value,
  onChange,
  open,
  onOpenChange,
  disabledIds,
  onBlurEmpty,
  inputRef,
  describedBy,
  invalid,
}: {
  /** The input's accessible name, for example "Recommended by 1". */
  label: string;
  people: readonly Person[];
  value: string;
  onChange: (userId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** People chosen in another row: shown, but not selectable here. */
  disabledIds?: ReadonlySet<string>;
  onBlurEmpty?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  describedBy?: string | undefined;
  invalid?: boolean;
}) {
  const options = useMemo(
    () => staffOptions(people, disabledIds ? { disabledIds } : {}),
    [people, disabledIds],
  );
  return (
    <Combobox
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Enter Name"
      groupThreshold={STAFF_GROUPING_THRESHOLD}
      emptyText="No staff members are available in this company."
      noMatchText="No matching staff members."
      {...(onBlurEmpty ? { onBlurEmpty } : {})}
      {...(inputRef ? { inputRef } : {})}
      describedBy={describedBy}
      {...(invalid ? { invalid } : {})}
    />
  );
}
