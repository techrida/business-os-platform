import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Stack } from '@/components/ui/stack';

import { Brand } from './brand';
import styles from './notice-card.module.css';

/**
 * A centred notice for pages outside the shell (staff-only, sign-in error): brand, one h1,
 * some text and the actions. It is the page's `main`.
 */
export function NoticeCard({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card as="main" className={styles.notice}>
      <Stack gap="large">
        <Brand />
        <Stack gap="small">
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.body}>{children}</div>
        </Stack>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </Stack>
    </Card>
  );
}
