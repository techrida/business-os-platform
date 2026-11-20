import type { ReactNode } from 'react';

import { getPermissionCheck } from '@/lib/live-permissions';
import { getSession } from '@/lib/session';
import { visibleSettingsGroups } from '@/lib/settings-nav';

import styles from './_components/chrome.module.css';
import { SectionTabs } from './_components/section-tabs';
import { SettingsSidebar } from './_components/settings-sidebar';

// Wraps every /settings page: the left-hand section list and the active section's sub-tab strip.
// It lists only the sections and sub-tabs the person may open (from live grants) and that have a
// page. It holds no access check on purpose: pages and actions run their own (see guard.ts),
// because a layout does not protect the pages rendered beside it. With no session it shows no
// menu and lets the page send the visitor to sign in.
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const groups = session ? visibleSettingsGroups(await getPermissionCheck(session)) : [];
  if (session && groups.length === 0) return <div className={styles.content}>{children}</div>;
  return (
    <div className={styles.frame}>
      <SettingsSidebar groups={groups} />
      <div className={styles.content}>
        <SectionTabs groups={groups} />
        {children}
      </div>
    </div>
  );
}
