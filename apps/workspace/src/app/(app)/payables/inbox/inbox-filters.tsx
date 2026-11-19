'use client';

import { FilterBar } from '@/components/ui/filter-bar';

/** Search for the bill inbox. Every row is waiting for a bill, so there is no status filter. */
export function InboxFilters({
  rows,
}: {
  /** Kept when the form is submitted without JavaScript. */
  rows: string | undefined;
}) {
  return (
    <FilterBar
      search={{ label: 'Search the inbox', placeholder: 'Search by vendor invoice or vendor' }}
      preserve={{ rows }}
    />
  );
}
