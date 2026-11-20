import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { getPermissionCheck } from '@/lib/live-permissions';
import { visibleSettingsGroups } from '@/lib/settings-nav';

import admin from './admin.module.css';
import styles from './_components/chrome.module.css';
import { requireSession } from './guard';

export const metadata: Metadata = { title: 'Settings · Business OS' };

// The Settings landing page: lists the sections the person may open (with links to each permitted
// sub-tab). On a phone (390px) it is the section menu/list; from 768px it is a grid of section
// cards beside the left-hand section sidebar. Keeps one H1 ("Settings").
export default async function SettingsIndexPage() {
  const session = await requireSession('/settings');
  const groups = visibleSettingsGroups(await getPermissionCheck(session));
  // Deny by default: nothing to open here means nothing to see.
  if (groups.length === 0) redirect('/settings/denied');

  return (
    <Page className={admin.page}>
      <PageHeader
        title="Settings"
        description="Setup that changes how the whole organisation works. Each change is recorded in the audit trail with your name."
      />
      <ul className={styles.sectionGrid} aria-label="Settings sections">
        {groups.map((group) => {
          const entryHref = group.sections[0]?.href ?? group.href;
          return (
            <li key={group.id} className={styles.sectionCard}>
              <div className={styles.sectionCardTop}>
                <Icon name={group.icon} size={20} className={styles.icon} />
                <div className={styles.rowText}>
                  <Link
                    href={entryHref}
                    className={styles.sectionCardLink}
                    aria-describedby={`settings-section-desc-${group.id}`}
                  >
                    {group.label}
                  </Link>
                  <span id={`settings-section-desc-${group.id}`} className={styles.rowDescription}>
                    {group.description}
                  </span>
                </div>
                <Icon name="chevron-right" size={18} className={styles.chevron} />
              </div>
              <ul className={styles.subtabLinks} aria-label={`${group.label} views`}>
                {group.sections.map((section) => (
                  <li key={section.href}>
                    <Link href={section.href} className={styles.subtabLink}>
                      {section.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}
