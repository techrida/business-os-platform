import Link from 'next/link';

import { MEMO_STATUS_FILTERS } from '@/lib/memo-list-view';

import styles from '../kit.module.css';

/** Status filter as plain links: no client state, works without JavaScript, the URL is the filter. */
export function MemoStatusFilter({ active }: { active: string | undefined }) {
  const items = [{ value: undefined, label: 'All' }, ...MEMO_STATUS_FILTERS];
  return (
    <nav className={styles.filters} aria-label="Filter memos by status">
      {items.map((f) => {
        const current = f.value === active;
        return (
          <Link
            key={f.value ?? 'all'}
            href={f.value ? `/memos?status=${f.value}` : '/memos'}
            className={styles.filter}
            aria-current={current ? 'page' : undefined}
          >
            {f.label}
          </Link>
        );
      })}
    </nav>
  );
}
