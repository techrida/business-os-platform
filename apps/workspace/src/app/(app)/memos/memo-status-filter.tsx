'use client';

import { useRouter } from 'next/navigation';

import { DropdownSelect } from '@/components/ui/dropdown-select';
import { MEMO_STATUS_FILTERS } from '@/lib/memo-list-view';

import styles from './memo-pages.module.css';

const OPTIONS = [
  { id: 'all', label: 'All statuses' },
  ...MEMO_STATUS_FILTERS.map(({ value, label }) => ({
    id: value,
    label: value === 'submitted' ? 'Submitted' : label,
  })),
];

export function MemoStatusFilter({ active }: { active: string | undefined }) {
  const router = useRouter();
  return (
    <div className={styles.filters}>
      <div className={styles.statusFilter}>
        <DropdownSelect
          aria-label="Filter memos by status"
          options={OPTIONS}
          selectedKey={active ?? 'all'}
          onSelectionChange={(value) => {
            if (value !== null) router.push(value === 'all' ? '/memos' : `/memos?status=${value}`);
          }}
        />
      </div>
      <noscript>
        <nav aria-label="Filter memos by status">
          {OPTIONS.map(({ id, label }) => (
            <a key={id} href={id === 'all' ? '/memos' : `/memos?status=${id}`}>
              {label}
            </a>
          ))}
        </nav>
      </noscript>
    </div>
  );
}
