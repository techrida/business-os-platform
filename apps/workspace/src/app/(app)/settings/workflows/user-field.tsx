import type { ReactNode } from 'react';

import { Field } from '@/components/ui/field';
import { MemberPicker } from '@/components/ui/member-picker';

export interface UserOption {
  id: string;
  /** "Name (email)": what the pickers show. */
  label: string;
  /** What a person row shows as the name. */
  name: string;
  /** Shown under the name; null when the name is already the email or there is none. */
  email: string | null;
  /** Job title and department, muted after the name (BOS-UI-001). */
  role?: string | null;
}

/** The people a workflow, group or delegation picker offers, as the one member picker takes them. */
export const memberOptions = (users: readonly UserOption[]) =>
  users.map((u) => ({ id: u.id, name: u.name, role: u.role ?? null }));

/**
 * Named choices come from the approval-management lookup. Failed lookups retain the saved target
 * and make new selection unavailable.
 */
export function UserField({
  name,
  label,
  users,
  defaultValue = '',
}: {
  name: string;
  label: ReactNode;
  users: readonly UserOption[] | null;
  defaultValue?: string;
}) {
  const available = users ?? [];
  return (
    <Field
      label={label}
      hint={
        users === null
          ? 'People could not be loaded. Reload or ask an administrator for access.'
          : available.length === 0
            ? 'No people are available to select.'
            : undefined
      }
    >
      {(control) => (
        <MemberPicker
          labelledBy={control['aria-labelledby']}
          describedBy={control['aria-describedby']}
          name={name}
          people={memberOptions(available)}
          defaultValue={defaultValue}
          current={
            defaultValue && !available.some((u) => u.id === defaultValue)
              ? { id: defaultValue, name: 'Current person (name unavailable)' }
              : undefined
          }
          required
          placeholder="Search by name"
          disabled={available.length === 0 && !defaultValue}
        />
      )}
    </Field>
  );
}
