'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

import { PAYMENT_METHOD_OPTIONS, PAYMENT_STATUS_OPTIONS } from '../_lib/status';

type Props = {
  status: readonly string[];
  method: readonly string[];
  /** Params the form keeps when it submits without JavaScript. */
  preserve: Readonly<Record<string, string | undefined>>;
};

function Controls({ status, method }: Pick<Props, 'status' | 'method'>) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <MultiSelect
        name="status"
        label="Status"
        options={PAYMENT_STATUS_OPTIONS}
        defaultValue={status}
        onChange={(next) => setParam('status', next)}
        allLabel="All statuses"
        pluralLabel="statuses"
      />
      <MultiSelect
        name="method"
        label="Method"
        options={PAYMENT_METHOD_OPTIONS}
        defaultValue={method}
        onChange={(next) => setParam('method', next)}
        allLabel="All methods"
        pluralLabel="methods"
      />
    </>
  );
}

/** The payment list's filters: instant search and dropdowns that write the URL; no Apply button. */
export function PaymentFilters({ preserve, ...values }: Props) {
  return (
    <FilterBar
      search={{ label: 'Search payments', placeholder: 'Search receipts or customers' }}
      preserve={preserve}
    >
      <Controls {...values} />
    </FilterBar>
  );
}
