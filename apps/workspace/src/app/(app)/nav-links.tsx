'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import styles from './shell.module.css';

/**
 * The main navigation. A Client Component only because the current page needs `usePathname`; it
 * sets `aria-current="page"` so screen readers and the stylesheet agree on where the user is.
 */
export function NavLinks({ links }: { links: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className={styles.nav}>
        {links.map((link) => {
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className={styles.navLink}
                {...(current ? { 'aria-current': 'page' as const } : {})}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
