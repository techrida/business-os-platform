'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

function StatusSelect({
  options,
  value,
}: {
  options: readonly MultiSelectOption[];
  value: readonly string[];
}) {
  const { setParam } = useFilterNavigation();
  return (
    <MultiSelect
      name="status"
      label="Status"
      options={options}
      value={value}
      onChange={(next) => setParam('status', next)}
      allLabel="All statuses"
      pluralLabel="statuses"
    />
  );
}

/** Search and status for the purchase order list; every change goes to the URL and the server re-renders. */
export function OrdersFilters({
  statusOptions,
  status,
  rows,
}: {
  statusOptions: readonly MultiSelectOption[];
  status: readonly string[];
  /** Kept when the form is submitted without JavaScript. */
  rows: string | undefined;
}) {
  return (
    <FilterBar
      search={{ label: 'Search purchase orders', placeholder: 'Search by number or vendor' }}
      preserve={{ rows }}
    >
      <StatusSelect options={statusOptions} value={status} />
    </FilterBar>
  );
}
