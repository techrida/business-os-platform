'use client';

import { useMemo, useState, type Ref } from 'react';

import { Combobox } from './combobox';
import type { ComboboxOption } from './combobox-model';

/**
 * BOS-UI-001: the one control for choosing a member of the organisation (lead owner, prepared by, signer, approver,
 * assignee, account owner, default owner in Settings, ...). A search-in-the-input combobox: type in the field to
 * filter, the list opens under it, and the chosen person reads as name followed by role (muted), the same as in the
 * list rows. Never put a placeholder phrase such as "Default owner" in the field when a real person is meant:
 * resolve the person and show them, and say where a default comes from in the field's hint.
 *
 * A plain `Select` of people is refused by `member-picker-guard.test.ts`.
 */

/** More people than this and the list is grouped by each person's `group` (their department). */
export const MEMBER_GROUPING_THRESHOLD = 20;

export interface MemberOption {
  /** The user id the form posts. */
  id: string;
  name: string;
  /** Job title and department, as the API words them; muted after the name. */
  role?: string | null | undefined;
  /** The heading this person sits under when the list is long (their department). */
  group?: string | null | undefined;
  /** Words that find this person but are not shown (an email address, for an administrator's search). */
  searchText?: string | undefined;
  /** Shown but not selectable (already chosen elsewhere). */
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}

/**
 * Turns people into combobox options. Two people can share a name and role, so a duplicate gets a short reference
 * after its role: never told apart by name alone.
 */
export function memberComboboxOptions(people: readonly MemberOption[]): ComboboxOption[] {
  const seen = new Map<string, number>();
  const key = (p: MemberOption) => `${p.name}\u0000${p.role ?? ''}`;
  for (const p of people) seen.set(key(p), (seen.get(key(p)) ?? 0) + 1);
  return people.map((p) => {
    const duplicate = (seen.get(key(p)) ?? 0) > 1;
    const role = [p.role, duplicate ? `ref ${p.id.slice(-8)}` : null].filter(Boolean).join(' · ');
    return {
      id: p.id,
      label: p.name,
      description: role === '' ? undefined : role,
      group: p.group,
      searchText: p.searchText,
      disabled: p.disabled,
      disabledReason: p.disabledReason,
    };
  });
}

export interface MemberPickerProps {
  /** The input's accessible name when no visible label points at it through `labelledBy`. */
  label?: string;
  labelledBy?: string | undefined;
  describedBy?: string | undefined;
  /** Posts the chosen user id under this name (a hidden input; the visible box posts nothing). */
  name?: string;
  people: readonly MemberOption[];
  /** Controlled: the chosen user id, or '' for none. Leave out (with `defaultValue`) for an uncontrolled field. */
  value?: string;
  defaultValue?: string;
  onChange?: (userId: string) => void;
  /**
   * A chosen person the list no longer holds (disabled since, or no longer assignable): kept in the box so a saved
   * record keeps showing its name, but not offered again.
   */
  current?: { id: string; name: string; role?: string | null | undefined } | undefined;
  /** Controlled list state, for rows that must keep one list open at a time (`useExclusiveOpen`). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  emptyText?: string;
  noMatchText?: string;
  required?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  onBlurEmpty?: () => void;
  /** The person an empty value stands for (a default applied elsewhere): shown while nothing is chosen. */
  emptyStandsFor?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

export function MemberPicker({
  label,
  labelledBy,
  describedBy,
  name,
  people,
  value,
  defaultValue = '',
  onChange,
  current,
  open,
  onOpenChange,
  placeholder = 'Search by name',
  emptyText = 'No one is available to choose.',
  noMatchText = 'No matching people.',
  required,
  invalid,
  disabled,
  onBlurEmpty,
  emptyStandsFor,
  inputRef,
  className,
}: MemberPickerProps) {
  const [ownValue, setOwnValue] = useState(defaultValue);
  const [ownOpen, setOwnOpen] = useState(false);
  const chosen = value ?? ownValue;
  const options = useMemo(() => {
    const listed = memberComboboxOptions(people);
    if (current === undefined || people.some((p) => p.id === current.id)) return listed;
    // Kept so the saved person still reads by name; disabled so it is not offered as a new choice.
    return [
      {
        id: current.id,
        label: current.name,
        description: current.role ?? undefined,
        disabled: true,
        disabledReason: 'Cannot be chosen again',
      },
      ...listed,
    ];
  }, [people, current]);
  return (
    <Combobox
      {...(label === undefined ? {} : { label })}
      {...(labelledBy === undefined ? {} : { labelledBy })}
      describedBy={describedBy}
      options={options}
      value={chosen}
      onChange={(id) => {
        setOwnValue(id);
        onChange?.(id);
      }}
      open={open ?? ownOpen}
      onOpenChange={onOpenChange ?? setOwnOpen}
      placeholder={placeholder}
      groupThreshold={MEMBER_GROUPING_THRESHOLD}
      emptyText={emptyText}
      noMatchText={noMatchText}
      showDescriptionWhenClosed
      {...(name === undefined ? {} : { name })}
      {...(required ? { required } : {})}
      {...(invalid ? { invalid } : {})}
      {...(disabled ? { disabled } : {})}
      {...(emptyStandsFor ? { emptyStandsFor } : {})}
      {...(onBlurEmpty ? { onBlurEmpty } : {})}
      {...(inputRef ? { inputRef } : {})}
      {...(className ? { className } : {})}
    />
  );
}
