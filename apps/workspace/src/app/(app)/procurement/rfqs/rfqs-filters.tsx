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

/** Search and status for the RFQ list; every change goes to the URL and the server re-renders. */
export function RfqsFilters({
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
      search={{ label: 'Search RFQs', placeholder: 'Search by RFQ or request number' }}
      preserve={{ rows }}
    >
      <StatusSelect options={statusOptions} value={status} />
    </FilterBar>
  );
}
