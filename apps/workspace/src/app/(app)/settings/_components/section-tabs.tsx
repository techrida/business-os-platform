'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef } from 'react';

import { Icon } from '@/components/ui/icon';
import { TabNav } from '@/components/ui/tab-nav';
import { groupForPath, sectionForPath, type SettingsGroup } from '@/lib/settings-nav';

import styles from './chrome.module.css';

/**
 * The active section's sub-tab strip (and, below 768px, a collapsible section menu above it).
 * Receives sections already filtered by live permissions and readiness from `SettingsLayout`.
 */
export function SectionTabs({ groups }: { groups: readonly SettingsGroup[] }) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const activeGroup = groupForPath(pathname, groups);
  if (!activeGroup) return null;

  const activeSubTab = sectionForPath(pathname, activeGroup.sections);
  if (!activeSubTab) return null;

  const closeMenu = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <div className={styles.sectionChrome}>
      <details ref={detailsRef} className={styles.mobileSections}>
        <summary className={styles.mobileSummary}>
          <Icon name={activeGroup.icon} size={18} className={styles.icon} />
          <span className={styles.mobileSummaryLabel}>{activeGroup.label}</span>
          <Icon name="chevron-down" size={16} className={styles.mobileChevron} />
        </summary>
        <ul className={styles.mobileMenuList} aria-label="Settings sections">
          {groups.map((group) => {
            const href = group.sections[0]?.href ?? group.href;
            const active = group.id === activeGroup.id;
            return (
              <li key={group.id}>
                <Link
                  href={href}
                  className={styles.mobileMenuItem}
                  aria-current={active ? 'true' : undefined}
                  onClick={closeMenu}
                >
                  <Icon name={group.icon} size={18} className={styles.icon} />
                  <span className={styles.itemLabel}>{group.label}</span>
                </Link>
              </li>
            );
          })}
          <li className={styles.mobileMenuAllRow}>
            <Link href="/settings" className={styles.mobileMenuAll} onClick={closeMenu}>
              All sections
            </Link>
          </li>
        </ul>
      </details>

      <div className={styles.tabStrip}>
        <TabNav
          label={`${activeGroup.label} views`}
          items={activeGroup.sections.map((section) => ({
            href: section.href,
            label: section.label,
          }))}
          activeHref={activeSubTab.href}
        />
      </div>
    </div>
  );
}
