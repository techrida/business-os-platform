'use client';

import { useState } from 'react';

import { Select } from '@/components/ui/field';
import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

import { SALES_ORDER_DEFAULT_ROWS, SALES_ORDER_ROW_OPTIONS } from './_lib/status';

/** The rows control follows the URL (back/forward) without waiting for the server to repaint. */
function Rows({ rows }: { rows: number }) {
  const { setParam } = useFilterNavigation();
  const [value, setValue] = useState(rows);
  const [seen, setSeen] = useState(rows);
  if (seen !== rows) {
    setSeen(rows);
    setValue(rows);
  }
  return (
    <Select
      name="rows"
      aria-label="Rows per page"
      value={value}
      onChange={(event) => {
        const next = Number(event.target.value);
        setValue(next);
        // The default stays out of the URL.
        setParam('rows', next === SALES_ORDER_DEFAULT_ROWS ? undefined : String(next));
      }}
    >
      {SALES_ORDER_ROW_OPTIONS.map((n) => (
        <option key={n} value={n}>
          {n} rows
        </option>
      ))}
    </Select>
  );
}

function Controls({
  statuses,
  customerIds,
  statusOptions,
  customerOptions,
  rows,
}: {
  statuses: readonly string[];
  customerIds: readonly string[];
  statusOptions: readonly MultiSelectOption[];
  customerOptions: readonly MultiSelectOption[] | null;
  rows: number;
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
      <Rows rows={rows} />
    </>
  );
}

/**
 * Instant filters for the sales-order list: the URL is the state, so there is no Apply button.
 * `customerOptions` is null when the customers could not be read; the filter is then left out.
 */
export function SalesOrderFilters(props: {
  statuses: readonly string[];
  customerIds: readonly string[];
  statusOptions: readonly MultiSelectOption[];
  customerOptions: readonly MultiSelectOption[] | null;
  rows: number;
}) {
  return (
    <FilterBar
      search={{ label: 'Search sales orders', placeholder: 'Search order, customer or quotation' }}
    >
      <Controls {...props} />
    </FilterBar>
  );
}
