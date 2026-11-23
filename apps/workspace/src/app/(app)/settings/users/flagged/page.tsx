import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { listFlaggedUsers, summarizeUsers } from '@/lib/api-admin';

import admin from '../../admin.module.css';
import { formatInstant } from '../../format';
import { requireSection } from '../../guard';
import { section } from '../../section';
import { SectionError } from '../../ui';
import styles from '../users.module.css';
import { describeFlagReason } from './flag-reason';
import { ResolveButton } from './resolve-button';

export const metadata: Metadata = { title: 'Flagged users · Business OS' };

const STATUS_LABELS = { active: 'Active', invited: 'Invited', inactive: 'Deactivated' } as const;

/**
 * People a failed or unsure write to the identity provider left flagged for review (FU8). Only a caller who may change
 * people's accounts (the same company-wide grant that resolves a flag) sees it; everyone else goes back to Users.
 */
export default async function FlaggedUsersPage() {
  const session = await requireSection('users', '/settings/users/flagged');
  const summary = await section('view user totals', () => summarizeUsers(session));
  if (summary.ok && summary.data.canChangeStatus !== true) redirect('/settings/users');
  const flagged = await section('view flagged users', () => listFlaggedUsers(session));

  return (
    <Page className={admin.page}>
      <Breadcrumb
        items={[{ label: 'Users', href: '/settings/users' }, { label: 'Flagged users' }]}
      />
      <PageHeader
        title="Flagged users"
        description="These people are closed in Business OS because a change to their sign-in account may not have finished. Check their account in the identity provider, fix it if it is wrong, then resolve the flag."
      />
      {!flagged.ok ? (
        <SectionError message={flagged.message} />
      ) : flagged.data.items.length === 0 ? (
        <EmptyState icon="check-circle" title="No flagged users">
          Nobody is waiting for an identity review.
        </EmptyState>
      ) : (
        <Table
          caption="Users flagged for identity review"
          minWidth={720}
          className={admin.local ?? ''}
        >
          <thead>
            <tr>
              <Th>User</Th>
              <Th>Why flagged</Th>
              <Th>Flagged</Th>
              <Th>Status</Th>
              <Th align="end">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {flagged.data.items.map((user, index) => {
              const displayName = user.displayName?.trim() || null;
              const name = displayName ?? 'Unnamed user';
              const label = user.email
                ? `${name} · ${user.email}`
                : (displayName ?? `${name} ${index + 1}`);
              return (
                <tr key={user.id}>
                  <Th scope="row" className={admin.rowHead}>
                    <span className={styles.personText}>
                      <span className={styles.name}>{name}</span>
                      {user.email && <span className={styles.email}>{user.email}</span>}
                    </span>
                  </Th>
                  <Td>{describeFlagReason(user.reason)}</Td>
                  <Td nowrap>
                    {user.flaggedAt ? (
                      <time dateTime={user.flaggedAt}>{formatInstant(user.flaggedAt)}</time>
                    ) : (
                      <span className={styles.muted}>Unknown</span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone="neutral">{STATUS_LABELS[user.status]}</Badge>
                  </Td>
                  <Td align="end">
                    <ResolveButton userId={user.id} name={name} label={label} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
