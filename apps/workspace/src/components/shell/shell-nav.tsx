'use client';

import { SearchInput } from '@/components/ui/search-input';
import { isBuilt, searchNavGroups, type NavGroup } from '@/lib/nav';

import { NavLink } from './nav-link';
import { useShell } from './shell-state';
import styles from './sidebar.module.css';
import { INBOX_HREF, useInboxCount } from './use-inbox-count';

export function ShellNavSearch({ className }: { className?: string | undefined }) {
  const { navQuery, setNavQuery } = useShell();
  return (
    <SearchInput
      aria-label="Search menu"
      aria-controls="app-navigation"
      placeholder="Search menu"
      wrapperClassName={className}
      value={navQuery}
      onChange={(event) => setNavQuery(event.currentTarget.value)}
    />
  );
}

export function ShellNav({
  groups,
  counts = {},
}: {
  groups: readonly NavGroup[];
  counts?: Readonly<Record<string, number>>;
}) {
  const { navQuery } = useShell();
  const matches = searchNavGroups(groups, navQuery);
  // The Inbox badge stays live; any other count is what the layout passed.
  const hasInbox = groups.some((group) => group.items.some((item) => item.href === INBOX_HREF));
  const inbox = useInboxCount(counts[INBOX_HREF], hasInbox);
  const shown = inbox === undefined ? counts : { ...counts, [INBOX_HREF]: inbox };

  return (
    <nav id="app-navigation" aria-label="Main" className={styles.nav}>
      <p className={matches.length === 0 ? styles.groupLabel : 'sr-only'} role="status">
        {matches.length === 0 ? 'No matching pages' : ''}
      </p>
      {matches.map((group, index) => {
        const labelId = `nav-group-${index}`;
        return (
          <div key={group.label} className={styles.group}>
            <p id={labelId} className={styles.groupLabel}>
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className={styles.items}>
              {group.items.filter(isBuilt).map((item) => (
                <li key={item.href}>
                  <NavLink
                    href={item.href}
                    label={item.label}
                    icon={item.icon}
                    count={shown[item.href] ?? item.count}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
