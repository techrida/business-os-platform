import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './tabs.module.css';

type TabNavItem = { href: string; label: ReactNode };

/** Use for sections with distinct URLs. Local panels use Tabs. */
export function TabNav({
  label,
  items,
  activeHref,
}: {
  label: string;
  items: readonly TabNavItem[];
  activeHref: string;
}) {
  return (
    <nav className={styles.list} aria-label={label}>
      {items.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={item.href === activeHref ? 'page' : undefined}
          className={styles.tab}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
