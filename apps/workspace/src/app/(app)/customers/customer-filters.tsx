'use client';

import { CUSTOMER_RELATIONSHIPS } from '@bos/contracts';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

export const RELATIONSHIP_LABEL: Record<(typeof CUSTOMER_RELATIONSHIPS)[number], string> = {
  prospect: 'Prospect',
  active: 'Active',
  inactive: 'Inactive',
};

function Controls({
  relationship,
  industry,
  industries,
}: {
  relationship: readonly string[];
  industry: readonly string[];
  industries: readonly string[];
}) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <MultiSelect
        name="relationship"
        label="Relationship"
        options={CUSTOMER_RELATIONSHIPS.map((value) => ({
          value,
          label: RELATIONSHIP_LABEL[value],
        }))}
        value={relationship}
        onChange={(values) => setParam('relationship', values)}
        allLabel="All relationships"
        pluralLabel="relationships"
      />
      {industries.length > 0 || industry.length > 0 ? (
        <MultiSelect
          name="industry"
          label="Industry"
          // A chosen industry stays listed even if no customer uses it now, so it can be turned off.
          options={[...new Set([...industries, ...industry])].map((value) => ({
            value,
            label: value,
          }))}
          value={industry}
          onChange={(values) => setParam('industry', values)}
          allLabel="All industries"
          pluralLabel="industries"
        />
      ) : null}
    </>
  );
}

/** The search box and filters of the organizations list; the URL is the state. */
export function CustomerFilters({
  relationship,
  industry,
  industries,
  rows,
}: {
  relationship: readonly string[];
  industry: readonly string[];
  industries: readonly string[];
  /** Kept in the URL by a no-JavaScript submit. */
  rows: number | undefined;
}) {
  return (
    <FilterBar
      search={{
        label: 'Search organizations',
        placeholder: 'Search organizations',
      }}
      preserve={{ rows: rows === undefined ? undefined : String(rows) }}
    >
      <Controls relationship={relationship} industry={industry} industries={industries} />
    </FilterBar>
  );
}
