'use client';

import { Select } from '@/components/ui/field';
import styles from './users.module.css';

export function PageSize({
  size,
  sizes,
  q,
  role,
  status,
}: {
  size: number;
  sizes: readonly number[];
  q: string;
  role: string;
  status: string;
}) {
  return (
    <form action="/admin/users" className={styles.pageSize}>
      {q && <input type="hidden" name="q" value={q} />}
      {role && <input type="hidden" name="role" value={role} />}
      {status && <input type="hidden" name="status" value={status} />}
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
