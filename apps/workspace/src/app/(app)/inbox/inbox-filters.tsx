'use client';

import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect } from '@/components/ui/multi-select';

import { DOCUMENT_TYPE_OPTIONS } from './inbox-params';

function TypeFilter({ selected }: { selected: readonly string[] }) {
  const { setParam } = useFilterNavigation();
  return (
    <MultiSelect
      name="documentType"
      label="Document type"
      options={DOCUMENT_TYPE_OPTIONS}
      defaultValue={selected}
      onChange={(values) => setParam('documentType', values)}
      allLabel="All document types"
      pluralLabel="document types"
    />
  );
}

/** The inbox toolbar: instant search plus a document-type multi-select, both written to the URL. */
export function InboxFilters({
  documentType,
  rows,
  decided,
}: {
  documentType: readonly string[];
  rows: number;
  decided?: string | undefined;
}) {
  return (
    <FilterBar
      search={{ label: 'Search approvals', placeholder: 'Search title, number or reason' }}
      preserve={{ rows: String(rows), decided }}
    >
      <TypeFilter selected={documentType} />
    </FilterBar>
  );
}
