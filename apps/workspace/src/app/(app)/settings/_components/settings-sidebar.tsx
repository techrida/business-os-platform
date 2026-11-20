'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { groupForPath, type SettingsGroup } from '@/lib/settings-nav';

import styles from './chrome.module.css';

/**
 * The Settings section sidebar. A client component only to know the current path for the highlight
 * and `aria-current`. It receives sections already filtered by live permissions and readiness,
 * and links each left-hand section to the first sub-tab the person may open.
 */
export function SettingsSidebar({ groups }: { groups: readonly SettingsGroup[] }) {
  const pathname = usePathname();
  const activeGroup = groupForPath(pathname, groups);
  if (groups.length === 0) return null;
  return (
    <nav aria-label="Settings" className={styles.sidebar}>
      <p id="settings-sections-label" className={styles.groupLabel}>
        Sections
      </p>
      <ul aria-labelledby="settings-sections-label" className={styles.items}>
        {groups.map((group) => {
          const href = group.sections[0]?.href ?? group.href;
          return (
            <li key={group.id}>
              <Link
                href={href}
                className={styles.item}
                aria-current={group.id === activeGroup?.id ? 'page' : undefined}
              >
                <Icon name={group.icon} size={18} className={styles.icon} />
                <span className={styles.itemLabel}>{group.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
