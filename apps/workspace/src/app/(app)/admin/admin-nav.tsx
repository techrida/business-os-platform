'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import styles from './admin.module.css';

const ITEMS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/roles', label: 'Roles' },
  { href: '/admin/workflows', label: 'Workflows' },
  { href: '/admin/settings', label: 'Settings' },
] as const;

// A Client Component only because the current page comes from the URL (usePathname).
export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.subnav} aria-label="Admin sections">
      {ITEMS.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          aria-current={pathname === item.href ? 'page' : undefined}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
