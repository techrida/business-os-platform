'use client';

import type { AdminUsersQuery } from '@bos/contracts';

import { Select } from '@/components/ui/field';
import styles from './users.module.css';

export function PageSize({
  size,
  sizes,
  filters,
}: {
  size: number;
  sizes: readonly number[];
  filters: Omit<AdminUsersQuery, 'page' | 'after'>;
}) {
  return (
    <form action="/settings/users" className={styles.pageSize}>
      {Object.entries(filters).map(([key, value]) =>
        key !== 'limit' && value ? (
          <input key={key} type="hidden" name={key} value={value} />
        ) : null,
      )}
      <label htmlFor="users-per-page">Rows</label>
      <Select
        id="users-per-page"
        name="limit"
        aria-label="Rows per page"
        defaultValue={size}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {sizes.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
      <noscript>
        <button type="submit">Apply</button>
      </noscript>
    </form>
  );
}
