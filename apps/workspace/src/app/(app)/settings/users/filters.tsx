'use client';

import { ROLE_KEYS, UserStatusSchema, type AdminUser } from '@bos/contracts';
import { useState } from 'react';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';
import { Select } from '@/components/ui/field';

import { roleLabel } from './role-checkboxes';

const USER_SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'lastActive', label: 'Last active' },
  { value: 'createdAt', label: 'Newest' },
] as const;

const STATUS_OPTIONS = UserStatusSchema.options.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));
const ROLE_OPTIONS = ROLE_KEYS.map((value) => ({ value, label: roleLabel(value) }));

/** A single-value control that follows the URL when it changes (back/forward) without waiting on the server to repaint. */
function useUrlValue(url: string) {
  const [value, setValue] = useState(url);
  const [seen, setSeen] = useState(url);
  if (seen !== url) {
    setSeen(url);
    setValue(url);
  }
  return [value, setValue] as const;
}

function Controls({
  statuses,
  roles,
  departmentId,
  sort,
  departments,
}: {
  statuses: readonly string[];
  roles: readonly string[];
  departmentId: string;
  sort: string;
  departments: readonly NonNullable<AdminUser['department']>[];
}) {
  const { setParam } = useFilterNavigation();
  const [department, setDepartment] = useUrlValue(departmentId);
  const [order, setOrder] = useUrlValue(sort);
  return (
    <>
      <Select
        name="departmentId"
        aria-label="Department"
        value={department}
        onChange={(event) => {
          setDepartment(event.target.value);
          setParam('departmentId', event.target.value);
        }}
      >
        <option value="">All departments</option>
        {departments.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
        {departmentId && !departments.some(({ id }) => id === departmentId) && (
          <option value={departmentId}>Unavailable department</option>
        )}
      </Select>
      <MultiSelect
        name="role"
        label="Role"
        options={ROLE_OPTIONS}
        defaultValue={roles}
        onChange={(values) => setParam('role', values)}
        allLabel="All roles"
        pluralLabel="roles"
      />
      <MultiSelect
        name="status"
        label="Status"
        options={STATUS_OPTIONS}
        defaultValue={statuses}
        onChange={(values) => setParam('status', values)}
        allLabel="All statuses"
        pluralLabel="statuses"
      />
      <Select
        name="sort"
        aria-label="Sort users"
        value={order}
        onChange={(event) => {
          setOrder(event.target.value);
          // The default order stays out of the URL.
          setParam('sort', event.target.value === 'name' ? undefined : event.target.value);
        }}
      >
        {USER_SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </>
  );
}

/** Instant filters for the user directory; the URL is the state, so there is no Apply button. */
export function UsersFilters({
  rows,
  ...controls
}: {
  rows: number;
  statuses: readonly string[];
  roles: readonly string[];
  departmentId: string;
  sort: string;
  departments: readonly NonNullable<AdminUser['department']>[];
}) {
  return (
    <FilterBar
      search={{ label: 'Search users', placeholder: 'Search name or email' }}
      preserve={{ rows: String(rows) }}
    >
      <Controls {...controls} />
    </FilterBar>
  );
}
