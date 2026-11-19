'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { Input } from '@/components/ui/field';
import { MultiSelect } from '@/components/ui/multi-select';

import {
  KIND_FILTER_OPTIONS,
  SETTLEMENT_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from '../_lib/meta';
import styles from './invoice.module.css';

export interface InvoiceFilterValues {
  status: readonly string[];
  kind: readonly string[];
  settlement: readonly string[];
  customerId: readonly string[];
  issuedFrom: string | undefined;
  issuedTo: string | undefined;
}

type Props = InvoiceFilterValues & {
  customers: readonly { id: string; name: string }[];
  /** Params the form keeps when it submits without JavaScript. */
  preserve: Readonly<Record<string, string | undefined>>;
};

function Controls({ customers, ...values }: Omit<Props, 'preserve'>) {
  const { setParam } = useFilterNavigation();
  // A chosen customer that is not in the choices (not shown yet, or no longer invoiced) stays selectable.
  const known = new Set(customers.map((c) => c.id));
  const options = [
    ...customers.map((c) => ({ value: c.id, label: c.name })),
    ...values.customerId
      .filter((id) => !known.has(id))
      .map((id) => ({ value: id, label: 'Selected customer' })),
  ];
  return (
    <>
      <MultiSelect
        name="customerId"
        label="Customer"
        options={options}
        defaultValue={values.customerId}
        onChange={(next) => setParam('customerId', next)}
        allLabel="All customers"
        pluralLabel="customers"
      />
      <MultiSelect
        name="kind"
        label="Kind"
        options={KIND_FILTER_OPTIONS}
        defaultValue={values.kind}
        onChange={(next) => setParam('kind', next)}
        allLabel="All kinds"
        pluralLabel="kinds"
      />
      <MultiSelect
        name="status"
        label="Status"
        options={STATUS_FILTER_OPTIONS}
        defaultValue={values.status}
        onChange={(next) => setParam('status', next)}
        allLabel="All statuses"
        pluralLabel="statuses"
      />
      <MultiSelect
        name="settlement"
        label="Payment"
        options={SETTLEMENT_FILTER_OPTIONS}
        defaultValue={values.settlement}
        onChange={(next) => setParam('settlement', next)}
        allLabel="Any payment state"
        pluralLabel="payment states"
      />
      <label className={styles.dateField}>
        <span>Issued from</span>
        {/* The key remounts the input when Back or Clear changes the URL under it. */}
        <Input
          key={`from-${values.issuedFrom ?? ''}`}
          type="date"
          name="issuedFrom"
          defaultValue={values.issuedFrom ?? ''}
          max={values.issuedTo}
          onChange={(event) => setParam('issuedFrom', event.currentTarget.value)}
        />
      </label>
      <label className={styles.dateField}>
        <span>to</span>
        <Input
          key={`to-${values.issuedTo ?? ''}`}
          type="date"
          name="issuedTo"
          defaultValue={values.issuedTo ?? ''}
          min={values.issuedFrom}
          onChange={(event) => setParam('issuedTo', event.currentTarget.value)}
        />
      </label>
    </>
  );
}

/** The invoice list's filters: instant search and dropdowns that write the URL; no Apply button. */
export function InvoiceFilters({ preserve, ...rest }: Props) {
  return (
    <FilterBar
      search={{ label: 'Search invoices', placeholder: 'Search invoices' }}
      preserve={preserve}
      className={styles.filters ?? ''}
    >
      <Controls {...rest} />
    </FilterBar>
  );
}
