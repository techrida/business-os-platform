'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

function Controls({
  view,
  stages,
  owners,
  stageOptions,
  ownerOptions,
}: {
  view: 'table' | 'board';
  stages: readonly string[];
  owners: readonly string[];
  stageOptions: readonly MultiSelectOption[];
  ownerOptions: readonly MultiSelectOption[];
}) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      {view === 'table' ? (
        <MultiSelect
          name="stage"
          label="Stage"
          options={stageOptions}
          defaultValue={stages}
          onChange={(values) => setParam('stage', values)}
          allLabel="All stages"
          pluralLabel="stages"
        />
      ) : null}
      {ownerOptions.length > 0 ? (
        <MultiSelect
          name="owner"
          label="Owner"
          options={ownerOptions}
          defaultValue={owners}
          onChange={(values) => setParam('owner', values)}
          allLabel="All owners"
          pluralLabel="owners"
        />
      ) : null}
    </>
  );
}

/** Instant filters for the opportunity list; the URL is the state, so there is no Apply button. */
export function OpportunityFilters({
  view,
  rows,
  ...controls
}: {
  view: 'table' | 'board';
  rows: number;
  stages: readonly string[];
  owners: readonly string[];
  stageOptions: readonly MultiSelectOption[];
  ownerOptions: readonly MultiSelectOption[];
}) {
  return (
    <FilterBar
      search={{ label: 'Search opportunities', placeholder: 'Search name or number' }}
      preserve={{ view: view === 'board' ? 'board' : undefined, rows: String(rows) }}
    >
      <Controls view={view} {...controls} />
    </FilterBar>
  );
}
