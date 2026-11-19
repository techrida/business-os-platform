'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

type Props = {
  view: 'table' | 'board';
  rows: number;
  stages: readonly string[];
  sources: readonly string[];
  owners: readonly string[];
  stageOptions: readonly MultiSelectOption[];
  sourceOptions: readonly MultiSelectOption[];
  /** Empty when the user directory is unavailable: the control is hidden, never half-working. */
  ownerOptions: readonly MultiSelectOption[];
};

function Controls({
  view,
  stages,
  sources,
  owners,
  stageOptions,
  sourceOptions,
  ownerOptions,
}: Omit<Props, 'rows'>) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <MultiSelect
        name="source"
        label="Source"
        options={sourceOptions}
        defaultValue={sources}
        onChange={(values) => setParam('source', values)}
        allLabel="All sources"
        pluralLabel="sources"
      />
      {/* The board's columns are the stages, so it has no stage filter. */}
      {view === 'table' ? (
        <MultiSelect
          name="stage"
          label="Status"
          options={stageOptions}
          defaultValue={stages}
          onChange={(values) => setParam('stage', values)}
          allLabel="All statuses"
          pluralLabel="statuses"
        />
      ) : null}
      {ownerOptions.length > 0 ? (
        <MultiSelect
          name="ownerUserId"
          label="Owner"
          options={ownerOptions}
          defaultValue={owners}
          onChange={(values) => setParam('ownerUserId', values)}
          allLabel="All owners"
          pluralLabel="owners"
        />
      ) : null}
    </>
  );
}

/** Instant filters for the lead list; the URL is the state, so there is no Apply button. */
export function LeadFilters({ rows, ...controls }: Props) {
  return (
    <FilterBar
      search={{ label: 'Search leads', placeholder: 'Search leads' }}
      preserve={{
        view: controls.view === 'board' ? 'board' : undefined,
        rows: String(rows),
      }}
    >
      <Controls {...controls} />
    </FilterBar>
  );
}
