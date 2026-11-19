import { DEFAULT_ROWS, type PageWindow, ROWS_OPTIONS } from '@bos/contracts';
import Link from 'next/link';

import { Pagination } from '@/components/ui/pagination';
import { hrefWith, type RawParams } from '@/lib/list-params';

import styles from './list-pager.module.css';

/**
 * Footer of a server-paged list: page links and a rows-per-page choice, both plain links built from the
 * CURRENT params, so filters, search and `view` survive and no Apply button is needed. A new `rows` drops
 * `page` (hrefWith does that), because the old page number no longer points at the same rows.
 */
export function ListPager({
  pathname,
  current,
  window,
  total,
  label,
}: {
  pathname: string;
  current: RawParams;
  window: PageWindow;
  total: number;
  label: string;
}) {
  const pageHref = (page: number) =>
    hrefWith(pathname, current, { page: page > 1 ? page : undefined });
  const first = Math.max(1, Math.min(window.page - 1, window.pageCount - 2));
  const pages = Array.from({ length: Math.min(3, window.pageCount) }, (_, index) => ({
    page: first + index,
    href: pageHref(first + index),
  }));
  return (
    <div className={styles.footer}>
      <Pagination
        label={label}
        summary={`Showing ${window.first}–${window.last} of ${total}`}
        {...(window.page > 1 ? { previousHref: pageHref(window.page - 1) } : {})}
        {...(window.page < window.pageCount ? { nextHref: pageHref(window.page + 1) } : {})}
        currentPage={window.page}
        pages={pages}
      />
      <nav className={styles.rows} aria-label="Rows per page">
        <span>Rows</span>
        {ROWS_OPTIONS.map((rows) => (
          <Link
            key={rows}
            href={hrefWith(pathname, current, { rows: rows === DEFAULT_ROWS ? undefined : rows })}
            className={styles.rowsLink}
            aria-current={rows === window.limit ? 'true' : undefined}
          >
            {rows}
          </Link>
        ))}
      </nav>
    </div>
  );
}
