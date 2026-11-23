'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { ownsPath, type NavIconName } from '@/lib/nav';

import styles from './sidebar.module.css';
import { useShell } from './shell-state';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * A built sidebar item. It is a client component only to know the current path (for the
 * highlight and `aria-current`) and to close the drawer after a tap.
 */
export function NavLink({
  href,
  label,
  icon,
  count,
}: {
  href: string;
  label: string;
  icon: NavIconName;
  count?: number | undefined;
}) {
  const pathname = usePathname();
  const { closeDrawer, setNavQuery } = useShell();
  const active = ownsPath(href, pathname);

  return (
    <Tooltip content={label}>
      <Link
        href={href}
        className={`${styles.item} ${styles.link}${active ? ` ${styles.active}` : ''}`}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          setNavQuery('');
          closeDrawer();
        }}
      >
        <Icon name={icon} className={styles.icon} />
        <span className={styles.label}>{label}</span>
        {count !== undefined && count > 0 ? <span className={styles.count}>{count}</span> : null}
      </Link>
    </Tooltip>
  );
}
