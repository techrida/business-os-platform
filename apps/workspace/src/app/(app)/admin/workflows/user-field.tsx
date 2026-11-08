import type { ReactNode } from 'react';

import { Field, Input, Select } from '@/components/ui/field';

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
 * `admin.users.read`, or the list failed) it is a text field for the user's id, so the form still works.
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
  return (
    <Field label={label}>
      {(control) =>
        users && users.length > 0 ? (
          <Select {...control} name={name} required defaultValue={defaultValue}>
            <option value="" disabled>
              Choose a person
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            {...control}
            name={name}
            required
            autoComplete="off"
            placeholder="User id"
            defaultValue={defaultValue}
          />
        )
      }
    </Field>
  );
}
