'use client';

import { VERIFICATION_STATUSES } from '@bos/contracts';

import { VERIFICATION_STATUS_LABEL } from '@/components/p2/customers/format';
import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

function Controls({ status }: { status: readonly string[] }) {
  const { setParam } = useFilterNavigation();
  return (
    <MultiSelect
      name="status"
      label="Status"
      options={VERIFICATION_STATUSES.map((value) => ({
        value,
        label: VERIFICATION_STATUS_LABEL[value].text,
      }))}
      value={status}
      onChange={(values) => setParam('status', values)}
      allLabel="All statuses"
      pluralLabel="statuses"
    />
  );
}

/** The search box and status filter of the verification queue; the URL is the state. */
export function VerificationFilters({
  status,
  rows,
}: {
  status: readonly string[];
  /** Kept in the URL by a no-JavaScript submit. */
  rows: number | undefined;
}) {
  return (
    <FilterBar
      search={{ label: 'Search cases', placeholder: 'Customer or vendor name or code' }}
      preserve={{ rows: rows === undefined ? undefined : String(rows) }}
    >
      <Controls status={status} />
    </FilterBar>
  );
}
