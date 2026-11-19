'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

import { MEMO_STATUS_OPTIONS } from './memo-list-params';

function StatusFilter({ selected }: { selected: readonly string[] }) {
  const { setParam } = useFilterNavigation();
  return (
    <MultiSelect
      name="status"
      label="Status"
      options={MEMO_STATUS_OPTIONS}
      value={selected}
      onChange={(values) => setParam('status', values)}
      allLabel="All statuses"
      pluralLabel="statuses"
    />
  );
}

/** The Memos toolbar: instant search plus a status multi-select, both written to the URL. */
export function MemoFilters({ status }: { status: readonly string[] }) {
  return (
    <FilterBar search={{ label: 'Search memos', placeholder: 'Search number, title or owner' }}>
      <StatusFilter selected={status} />
    </FilterBar>
  );
}
