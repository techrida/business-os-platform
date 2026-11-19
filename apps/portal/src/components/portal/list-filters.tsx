'use client';

import { FilterBar, ResultCount, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

import styles from './list-filters.module.css';

export type ListFilter = {
  /** URL param, repeated once per selected value. */
  name: string;
  label: string;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  allLabel: string;
  pluralLabel: string;
};

function FilterSelect({ filter }: { filter: ListFilter }) {
  const { setParam } = useFilterNavigation();
  return (
    <MultiSelect
      name={filter.name}
      label={filter.label}
      options={filter.options}
      value={filter.value}
      onChange={(values) => setParam(filter.name, values)}
      allLabel={filter.allLabel}
      pluralLabel={filter.pluralLabel}
    />
  );
}

/**
 * The search box, status-style multi-selects and the result count for a portal list. Filters apply
 * as they change (no Apply button); without JavaScript the box is a plain GET form.
 */
export function ListFilters({
  searchLabel,
  placeholder,
  filters,
  shown,
  total,
  noun,
  plural,
}: {
  searchLabel: string;
  placeholder: string;
  filters: readonly ListFilter[];
  shown: number;
  total: number;
  noun: string;
  plural?: string;
}) {
  return (
    <div className={styles.wrap}>
      <FilterBar search={{ label: searchLabel, placeholder }}>
        {filters.map((filter) => (
          <FilterSelect key={filter.name} filter={filter} />
        ))}
      </FilterBar>
      <ResultCount shown={shown} total={total} noun={noun} {...(plural ? { plural } : {})} />
    </div>
  );
}
