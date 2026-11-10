import type { ReactNode } from 'react';

import styles from './link-card.module.css';

export function LinkCardList({ children }: { children: ReactNode }) {
  return <ul className={styles.list}>{children}</ul>;
}

/**
 * A card with one link. The link is a plain anchor (not next/link) because some targets are
 * route handlers that must not be prefetched. The link's own text is its accessible name; the
 * rest of the card (`children`) sits outside the anchor and the whole card is clickable.
 */
export function LinkCard({
  href,
  title,
  children,
}: {
  href: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className={styles.card}>
      <a className={styles.link} href={href}>
        {title}
      </a>
      {children ? <div className={styles.meta}>{children}</div> : null}
    </li>
  );
}
