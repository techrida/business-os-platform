'use client';

import { useState } from 'react';

import { DatePicker } from '@/components/ui/date-picker';
import { FilterBar, useFilterNavigation } from '@/components/ui/filter-bar';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';

/** One end of the due-day range. Follows the URL when it changes under it (back/forward, Clear filters). */
function DueDay({
  name,
  label,
  value,
  min,
  max,
}: {
  name: 'dueFrom' | 'dueTo';
  label: string;
  value: string;
  min?: string | undefined;
  max?: string | undefined;
}) {
  const { setParam } = useFilterNavigation();
  const [day, setDay] = useState(value);
  const [seen, setSeen] = useState(value);
  // The last day sent to the URL: a change back to the server's value must still navigate while an
  // earlier request is in flight.
  const [requested, setRequested] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDay(value);
    setRequested(value);
  }
  return (
    <DatePicker
      name={name}
      aria-label={label}
      // A filter bar holds a row of controls; a line under one would push it out of line.
      showBs={false}
      value={day}
      min={min || undefined}
      max={max || undefined}
      onChange={(next) => {
        setDay(next);
        // '' is a cleared date; a half-typed one never reaches here.
        if (next !== requested) {
          setRequested(next);
          setParam(name, next || undefined);
        }
      }}
    />
  );
}

function Controls({
  kinds,
  kindOptions,
  dueFrom,
  dueTo,
}: {
  kinds: readonly string[];
  kindOptions: readonly MultiSelectOption[];
  dueFrom: string;
  dueTo: string;
}) {
  const { setParam } = useFilterNavigation();
  return (
    <>
      <MultiSelect
        name="kind"
        label="Type"
        options={kindOptions}
        defaultValue={kinds}
        onChange={(values) => setParam('kind', values)}
        allLabel="All types"
        pluralLabel="types"
      />
      <DueDay name="dueFrom" label="Due from" value={dueFrom} max={dueTo} />
      <DueDay name="dueTo" label="Due to" value={dueTo} min={dueFrom} />
    </>
  );
}

/** Instant filters for the activity list; the URL is the state, so there is no Apply button. */
export function ActivityFilters({
  rows,
  kinds,
  kindOptions,
  dueFrom = '',
  dueTo = '',
}: {
  rows: number;
  kinds: readonly string[];
  kindOptions: readonly MultiSelectOption[];
  /** Due days `YYYY-MM-DD`, or '' for an open end. */
  dueFrom?: string;
  dueTo?: string;
}) {
  return (
    <FilterBar
      search={{ label: 'Search activities', placeholder: 'Search subject or details' }}
      preserve={{ rows: String(rows) }}
    >
      <Controls kinds={kinds} kindOptions={kindOptions} dueFrom={dueFrom} dueTo={dueTo} />
    </FilterBar>
  );
}
