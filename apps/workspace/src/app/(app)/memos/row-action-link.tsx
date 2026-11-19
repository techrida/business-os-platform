import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './row-action-link.module.css';

/**
 * An icon-only link for the end of a table row (Figma row view icon). `label` is the accessible name and
 * names the row ("View Office move"); `tooltip` is the short action shown on hover and keyboard focus.
 */
export function RowActionLink({
  href,
  label,
  tooltip,
  children,
}: {
  href: string;
  label: string;
  tooltip: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={styles.action} aria-label={label} data-tooltip={tooltip}>
      {children}
    </Link>
  );
}

/** The right-aligned cell content that holds one or more row actions. */
export function RowActions({ children }: { children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}
