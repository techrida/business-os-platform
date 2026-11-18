import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './pagination.module.css';

type PageLink = { page: number; href: string };

type PaginationProps = {
  label?: string;
  summary?: ReactNode;
  previousHref?: string;
  nextHref?: string;
  pages?: readonly PageLink[];
  currentPage?: number;
};

/** URLs are owned by the caller so numbered and cursor-based lists retain their filters. */
export function Pagination({
  label = 'Pagination',
  summary,
  previousHref,
  nextHref,
  pages = [],
  currentPage,
}: PaginationProps) {
  return (
    <div className={styles.footer}>
      {summary && <p>{summary}</p>}
      <nav className={styles.pages} aria-label={label}>
        {previousHref ? (
          <Link href={previousHref} className={styles.link}>
            Previous
          </Link>
        ) : (
          <span className={styles.disabled}>Previous</span>
        )}
        {pages.map(({ page, href }) => (
          <Link
            key={page}
            href={href}
            className={styles.link}
            aria-label={`Page ${page}`}
            aria-current={page === currentPage ? 'page' : undefined}
          >
            {page}
          </Link>
        ))}
        {nextHref ? (
          <Link href={nextHref} className={styles.link}>
            Next
          </Link>
        ) : (
          <span className={styles.disabled}>Next</span>
        )}
      </nav>
    </div>
  );
}
