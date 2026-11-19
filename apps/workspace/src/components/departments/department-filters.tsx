'use client';

import { DEPARTMENT_STATUSES } from '@bos/contracts';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

const STATUS_OPTIONS = DEPARTMENT_STATUSES.map((value) => ({
  value,
  label: value === 'active' ? 'Active' : 'Retired',
}));

function StatusFilter({ statuses }: { statuses: readonly string[] }) {
  const { setParam } = useFilterNavigation();
  // No status in the URL means the default view: active departments only.
  const shown = statuses.length === 0 ? ['active'] : statuses;
  return (
    <MultiSelect
      name="status"
      label="Status"
      options={STATUS_OPTIONS}
      defaultValue={shown}
      onChange={(values) =>
        // The default stays out of the URL; clearing the filter goes back to it.
        setParam('status', values.length === 1 && values[0] === 'active' ? undefined : values)
      }
      allLabel="Active"
      pluralLabel="statuses"
    />
  );
}

/** Instant search and Status filter for the department list; the URL holds the state. */
export function DepartmentFilters({ statuses }: { statuses: readonly string[] }) {
  return (
    <FilterBar search={{ label: 'Search departments', placeholder: 'Search by name' }}>
      <StatusFilter statuses={statuses} />
    </FilterBar>
  );
}
