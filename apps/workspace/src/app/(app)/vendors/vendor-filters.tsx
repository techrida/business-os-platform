'use client';

import { VENDOR_KINDS, VENDOR_STATUSES } from '@bos/contracts';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

import { VENDOR_KIND_LABEL, VENDOR_STATUS_LABEL } from './_lib/model';

function Controls({ status, kind }: { status: readonly string[]; kind: readonly string[] }) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <MultiSelect
        name="status"
        label="Status"
        options={VENDOR_STATUSES.map((value) => ({
          value,
          label: VENDOR_STATUS_LABEL[value].text,
        }))}
        value={status}
        onChange={(values) => setParam('status', values)}
        allLabel="All statuses"
        pluralLabel="statuses"
      />
      <MultiSelect
        name="kind"
        label="Kind"
        options={VENDOR_KINDS.map((value) => ({ value, label: VENDOR_KIND_LABEL[value] }))}
        value={kind}
        onChange={(values) => setParam('kind', values)}
        allLabel="All kinds"
        pluralLabel="kinds"
      />
    </>
  );
}

/** The search box and filters of the vendors list; the URL is the state. */
export function VendorFilters({
  status,
  kind,
  rows,
}: {
  status: readonly string[];
  kind: readonly string[];
  /** Kept in the URL by a no-JavaScript submit. */
  rows: number | undefined;
}) {
  return (
    <FilterBar
      search={{
        label: 'Search vendors',
        placeholder: 'Legal name or PAN',
      }}
      preserve={{ rows: rows === undefined ? undefined : String(rows) }}
    >
      <Controls status={status} kind={kind} />
    </FilterBar>
  );
}
