import type { ReactNode } from 'react';

import { AccessTabs } from '@/components/access/access-tabs';
import { Page, PageHeader } from '@/components/ui/page';

import { BackToSettings } from '../_components/back-link';
import admin from '../admin.module.css';
import styles from './access.module.css';

// The frame every Access tab shares: the page's `main`, its one heading and the tab bar. The tab
// pages (By area, By role, Check a person) render only their own content below it. No access
// check here on purpose: each page and Server Action runs `requireSection('roles')` itself,
// because a layout does not protect the pages rendered inside it (see ../guard.ts).
export default function AccessLayout({ children }: { children: ReactNode }) {
  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Access"
        description="Decide who can see each part of the business and who can hand work to whom."
      />
      <AccessTabs />
      <div className={styles.tabBody}>{children}</div>
    </Page>
  );
}
