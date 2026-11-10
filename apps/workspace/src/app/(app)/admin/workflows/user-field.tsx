import type { ReactNode } from 'react';

import { Field, Select } from '@/components/ui/field';

export interface UserOption {
  id: string;
  /** "Name (email)": what the pickers show. */
  label: string;
  /** What a person row shows as the name. */
  name: string;
  /** Shown under the name; null when the name is already the email or there is none. */
  email: string | null;
}

/**
 * Picks a person by id. With a user list it is a select; without one (the viewer lacks
 * `admin.users.read`, or the list failed) new selection is unavailable.
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
        <Select
          {...control}
          name={name}
          required
          defaultValue={defaultValue}
          disabled={available.length === 0 && !defaultValue}
        >
          <option value="" disabled>
            Choose a person
          </option>
          {defaultValue && !available.some((u) => u.id === defaultValue) ? (
            <option value={defaultValue}>Current person (name unavailable)</option>
          ) : null}
          {available.map((u) => (
            <option key={u.id} value={u.id}>
              {u.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
