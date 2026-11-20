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

// The index of every section the person may open. On a phone it is the menu (56px rows with a
// chevron); from 768px it is a grid of cards beside the sub-sidebar.
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
      <div className={styles.groups}>
        {groups.map((group, index) => (
          <section key={group.label} aria-labelledby={`settings-index-${index}`}>
            <h2 id={`settings-index-${index}`} className={styles.groupHead}>
              {group.label}
            </h2>
            <ul className={styles.rows}>
              {group.sections.map((section) => (
                <li key={section.href} className={styles.row}>
                  <Icon name={section.icon} size={20} className={styles.icon} />
                  <div className={styles.rowText}>
                    <Link
                      href={section.href}
                      className={styles.rowLink}
                      aria-describedby={`settings-index-${section.id}`}
                    >
                      {section.label}
                    </Link>
                    <span id={`settings-index-${section.id}`} className={styles.rowDescription}>
                      {section.description}
                    </span>
                  </div>
                  <Icon name="chevron-right" size={18} className={styles.chevron} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Page>
  );
}
