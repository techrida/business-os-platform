import type { PageWindow } from '@bos/contracts';

import { LinkButton } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { hrefWith, type RawParams } from '@/lib/list-params';

import styles from './list-footer.module.css';

const PAGE_LINKS = 5;

/** Up to five page numbers around the current one. */
function pageNumbers(current: number, count: number): number[] {
  const start = Math.max(1, Math.min(current - 2, count - PAGE_LINKS + 1));
  const end = Math.min(count, start + PAGE_LINKS - 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

/** "Showing a–b of N", page links and the Rows control; every link keeps the current filters. */
export function ListFooter({
  label,
  pathname,
  params,
  pageInfo,
  total,
  noun,
  plural,
  rowsOptions,
}: {
  label: string;
  pathname: string;
  params: RawParams;
  pageInfo: PageWindow;
  total: number;
  noun: string;
  plural: string;
  rowsOptions: readonly number[];
}) {
  const at = (page: number) => hrefWith(pathname, params, { page: page > 1 ? page : null });
  return (
    <div className={styles.footer}>
      <Pagination
        label={label}
        summary={`Showing ${pageInfo.first}–${pageInfo.last} of ${total} ${total === 1 ? noun : plural}`}
        currentPage={pageInfo.page}
        pages={pageNumbers(pageInfo.page, pageInfo.pageCount).map((page) => ({
          page,
          href: at(page),
        }))}
        {...(pageInfo.page > 1 ? { previousHref: at(pageInfo.page - 1) } : {})}
        {...(pageInfo.page < pageInfo.pageCount ? { nextHref: at(pageInfo.page + 1) } : {})}
      />
      <nav aria-label="Rows per page" className={styles.rows}>
        <span aria-hidden="true">Rows</span>
        {rowsOptions.map((size) => (
          <LinkButton
            key={size}
            href={hrefWith(pathname, params, { rows: size })}
            variant={size === pageInfo.limit ? 'secondary' : 'tertiary'}
            size="small"
            aria-current={size === pageInfo.limit ? 'true' : undefined}
            aria-label={`${size} rows per page`}
          >
            {size}
          </LinkButton>
        ))}
      </nav>
    </div>
  );
}
