'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Select } from '@/components/ui/field';
import { hrefWith } from '@/lib/list-params';

import styles from './users.module.css';

/** Rows per page. Built from the current URL so filters and search survive; the page number resets. */
export function PageSize({
  size,
  sizes,
  defaultSize,
}: {
  size: number;
  sizes: readonly number[];
  defaultSize: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  return (
    <div className={styles.pageSize}>
      <label htmlFor="users-per-page">Rows</label>
      <Select
        id="users-per-page"
        name="rows"
        aria-label="Rows per page"
        defaultValue={size}
        onChange={(event) => {
          const rows = Number(event.target.value);
          const href = hrefWith(pathname, searchParams ?? new URLSearchParams(), {
            rows: rows === defaultSize ? undefined : rows,
            after: undefined,
          });
          startTransition(() => router.push(href, { scroll: false }));
        }}
      >
        {sizes.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </Select>
    </div>
  );
}
