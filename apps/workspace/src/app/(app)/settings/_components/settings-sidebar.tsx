'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { sectionForPath, type SettingsGroup } from '@/lib/settings-nav';

import styles from './chrome.module.css';

/**
 * The Settings sub-sidebar. A client component only to know the current path for the highlight
 * and `aria-current`. It receives groups already filtered by permission and readiness.
 */
export function SettingsSidebar({ groups }: { groups: readonly SettingsGroup[] }) {
  const pathname = usePathname();
  const current = sectionForPath(pathname)?.href;
  if (groups.length === 0) return null;
  return (
    <nav aria-label="Settings" className={styles.sidebar}>
      {groups.map((group, index) => (
        <div key={group.label} className={styles.group}>
          <p id={`settings-group-${index}`} className={styles.groupLabel}>
            {group.label}
          </p>
          <ul aria-labelledby={`settings-group-${index}`} className={styles.items}>
            {group.sections.map((section) => (
              <li key={section.href}>
                <Link
                  href={section.href}
                  className={styles.item}
                  aria-current={section.href === current ? 'page' : undefined}
                >
                  <Icon name={section.icon} size={18} className={styles.icon} />
                  <span className={styles.itemLabel}>{section.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
