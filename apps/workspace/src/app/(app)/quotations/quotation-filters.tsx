'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

function Controls({
  statuses,
  customerIds,
  statusOptions,
  customerOptions,
}: {
  statuses: readonly string[];
  customerIds: readonly string[];
  statusOptions: readonly MultiSelectOption[];
  customerOptions: readonly MultiSelectOption[] | null;
}) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <MultiSelect
        name="status"
        label="Status"
        options={statusOptions}
        defaultValue={statuses}
        onChange={(values) => setParam('status', values)}
        allLabel="All statuses"
        pluralLabel="statuses"
      />
      {customerOptions !== null && (
        <MultiSelect
          name="customerId"
          label="Customer"
          options={customerOptions}
          defaultValue={customerIds}
          onChange={(values) => setParam('customerId', values)}
          allLabel="All customers"
          pluralLabel="customers"
        />
      )}
    </>
  );
}

/**
 * Instant filters for the quotation list: the URL is the state, so there is no Apply button.
 * `customerOptions` is null when the customers could not be read; the filter is then left out.
 * `opportunityId` and `rows` are kept by the no-JavaScript form.
 */
export function QuotationFilters({
  opportunityId,
  rows,
  ...controls
}: {
  opportunityId: string | undefined;
  rows: number;
  statuses: readonly string[];
  customerIds: readonly string[];
  statusOptions: readonly MultiSelectOption[];
  customerOptions: readonly MultiSelectOption[] | null;
}) {
  return (
    <FilterBar
      search={{
        label: 'Search quotations',
        placeholder: 'Search number, customer or owner',
      }}
      preserve={{ opportunityId, rows: String(rows) }}
    >
      <Controls {...controls} />
    </FilterBar>
  );
}
