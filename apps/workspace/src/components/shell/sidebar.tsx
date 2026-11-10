import { Icon } from '@/components/ui/icon';
import { NAV_GROUPS, isBuilt, type NavItem } from '@/lib/nav';

import { Brand } from './brand';
import { NavLink } from './nav-link';
import { CollapseToggle, DrawerCloseButton } from './shell-state';
import styles from './sidebar.module.css';

export interface SidebarUser {
  /** First line of the user card (in bold), for example the roles. */
  name: string;
  /** Second line, for example the organisation kind. */
  detail: string;
}

/** Up to two initials from the first role: "super_admin, auditor" gives "SA". */
function initialsOf(text: string): string {
  const first = text.split(',')[0] ?? '';
  const letters = first
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase());
  return letters.join('') || '?';
}

/** An item that is not built yet: not a link, dimmed, with no tag. */
function PlannedItem({ item }: { item: NavItem }) {
  const description = `${item.label}, not available yet`;
  return (
    <span className={`${styles.item} ${styles.planned}`} aria-disabled="true" title={description}>
      <Icon name={item.icon} className={styles.icon} />
      <span className={styles.label}>{item.label}</span>
      <span className="sr-only">, not available yet</span>
    </span>
  );
}

/**
 * The sidebar: brand and collapse control, the nav groups from the registry, the user card.
 * One element in every mode. Wide: 220px, or 108px when collapsed. Under 1024px: always the
 * 108px rail. Under 768px: a drawer, hidden (and not focusable) until the menu button opens it.
 */
export function Sidebar({ user }: { user: SidebarUser }) {
  return (
    <div id="app-sidebar" className={styles.sidebar}>
      <div className={styles.top}>
        <Brand />
        <CollapseToggle />
        <DrawerCloseButton />
      </div>

      <div className={styles.searchWrap}>
        <Icon name="search" size={16} className={styles.searchIcon} />
        <input
          type="search"
          className={styles.search}
          aria-label="Search menu"
          placeholder="Search menu"
          disabled
        />
      </div>

      <nav aria-label="Main" className={styles.nav}>
        {NAV_GROUPS.map((group, index) => {
          const labelId = `nav-group-${index}`;
          return (
            <div key={group.label} className={styles.group}>
              <p id={labelId} className={styles.groupLabel}>
                {group.label}
              </p>
              <ul aria-labelledby={labelId} className={styles.items}>
                {group.items.map((item) => (
                  <li key={item.label}>
                    {isBuilt(item) ? (
                      <NavLink
                        href={item.href}
                        label={item.label}
                        icon={item.icon}
                        count={item.count}
                      />
                    ) : (
                      <PlannedItem item={item} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className={styles.footer}>
        <div className={styles.userCard}>
          <span className={styles.avatar} aria-hidden="true">
            {initialsOf(user.name)}
          </span>
          <span className={styles.userText}>
            <span className={styles.userName}>{user.name}</span>
            <span className={styles.userDetail}>{user.detail}</span>
          </span>
          <Icon name="chevron-right" size={16} className={styles.userChevron} />
        </div>
      </div>
    </div>
  );
}
