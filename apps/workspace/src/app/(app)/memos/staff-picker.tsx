'use client';
import type { MemoDirectory } from '@bos/contracts';
import { useMemo, type Ref } from 'react';

import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox-model';

/** More staff than this and the list is grouped by their real directory department. */
export const STAFF_GROUPING_THRESHOLD = 20;

type Person = MemoDirectory['people'][number];

/**
 * The people a Recommended or Approved field may offer: those who can decide approvals (the server worked out
 * `canApprove` from their live roles). The person already in this field stays listed, so a saved memo keeps showing
 * its names; the server refuses to submit one who has since lost the right.
 */
export function approverChoices(people: readonly Person[], own: string): readonly Person[] {
  return people.filter((p) => p.canApprove || p.userId === own);
}

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
  emptyText = 'No staff members are available in this company.',
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
  /** Shown when the list has no one at all (for approvers: no one holds approval rights). */
  emptyText?: string;
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
      emptyText={emptyText}
      noMatchText="No matching staff members."
      {...(onBlurEmpty ? { onBlurEmpty } : {})}
      {...(inputRef ? { inputRef } : {})}
      describedBy={describedBy}
      {...(invalid ? { invalid } : {})}
    />
  );
}
