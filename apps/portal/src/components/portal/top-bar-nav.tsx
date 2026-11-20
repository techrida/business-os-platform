'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import styles from './top-bar.module.css';

/** The customer's four areas. Quotations is the landing page, so it owns `/` as well. */
const LINKS = [
  { label: 'Quotations', href: '/', owns: ['/', '/quotations'] },
  { label: 'Milestones', href: '/milestones', owns: ['/milestones'] },
  { label: 'Invoices', href: '/invoices', owns: ['/invoices'] },
  { label: 'Payments', href: '/payments', owns: ['/payments'] },
] as const;

/** True when `pathname` is the area's page or one under it (`/invoices` owns `/invoices/abc`). */
export function ownsPortalPath(owns: readonly string[], pathname: string): boolean {
  return owns.some((base) =>
    base === '/' ? pathname === '/' : pathname === base || pathname.startsWith(`${base}/`),
  );
}

/** Client component only to know the current path, for the highlight and `aria-current`. */
export function TopBarNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Customer portal">
      {LINKS.map((link) => {
        const active = ownsPortalPath(link.owns, pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={`${styles.link}${active ? ` ${styles.active}` : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
