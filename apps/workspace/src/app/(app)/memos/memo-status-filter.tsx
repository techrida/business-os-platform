'use client';

import { useRouter } from 'next/navigation';

import { Select } from '@/components/ui/select';
import { MEMO_STATUS_FILTERS } from '@/lib/memo-list-view';

import styles from './memo-pages.module.css';

const OPTIONS = [
  { value: 'all', label: 'All statuses' },
  ...MEMO_STATUS_FILTERS.map(({ value, label }) => ({
    value,
    label: value === 'submitted' ? 'Submitted' : label,
  })),
];

export function MemoStatusFilter({ active }: { active: string | undefined }) {
  const router = useRouter();
  return (
    <div className={styles.filters}>
      <div className={styles.statusFilter}>
        <Select
          aria-label="Filter memos by status"
          options={OPTIONS}
          value={active ?? 'all'}
          onChange={({ target }) =>
            router.push(target.value === 'all' ? '/memos' : `/memos?status=${target.value}`)
          }
        />
      </div>
      <noscript>
        <nav aria-label="Filter memos by status">
          {OPTIONS.map(({ value, label }) => (
            <a key={value} href={value === 'all' ? '/memos' : `/memos?status=${value}`}>
              {label}
            </a>
          ))}
        </nav>
      </noscript>
    </div>
  );
}
