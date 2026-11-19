'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

function Controls({
  kinds,
  kindOptions,
}: {
  kinds: readonly string[];
  kindOptions: readonly MultiSelectOption[];
}) {
  const { setParam } = useFilterNavigation();
  return (
    <MultiSelect
      name="kind"
      label="Type"
      options={kindOptions}
      defaultValue={kinds}
      onChange={(values) => setParam('kind', values)}
      allLabel="All types"
      pluralLabel="types"
    />
  );
}

/** Instant filters for the activity list; the URL is the state, so there is no Apply button. */
export function ActivityFilters({
  rows,
  kinds,
  kindOptions,
}: {
  rows: number;
  kinds: readonly string[];
  kindOptions: readonly MultiSelectOption[];
}) {
  return (
    <FilterBar
      search={{ label: 'Search activities', placeholder: 'Search subject or details' }}
      preserve={{ rows: String(rows) }}
    >
      <Controls kinds={kinds} kindOptions={kindOptions} />
    </FilterBar>
  );
}
