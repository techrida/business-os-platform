import Link from 'next/link';

import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { getInbox, getUnreadCount, listNotifications } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { canSeeAdmin, when } from '@/lib/kernel-format';

import styles from './overview.module.css';

export default async function OverviewPage() {
  const session = await requireStaffSession('/');
  const [inbox, unread, notifications] = await Promise.allSettled([
    getInbox(session),
    getUnreadCount(session),
    listNotifications(session, { limit: 5 }),
  ]);

  const approvals = inbox.status === 'fulfilled' ? inbox.value : null;

  return (
    <Page>
      <PageHeader title="Welcome back" description="Here’s what needs your attention today." />

      <div className={styles.hero}>
        {approvals !== null && (
          <Card as="section" aria-labelledby="overview-approvals" className={styles.nudge}>
            <div>
              <p className={styles.eyebrow}>Your inbox</p>
              <h2 id="overview-approvals">
                {approvals.length === 0
                  ? 'You’re caught up'
                  : `${approvals.length} ${approvals.length === 1 ? 'approval' : 'approvals'} to review`}
              </h2>
            </div>
            <LinkButton className={styles.inboxLink} variant="tertiary" href="/inbox">
              {approvals.length === 0 ? 'Open inbox' : 'Review all'}
              <Icon name="chevron-right" size={16} />
            </LinkButton>
          </Card>
        )}
        <Panel className={styles.quickActions} title="Quick actions">
          <div className={styles.shortcuts}>
            <LinkButton className={styles.shortcut} variant="tertiary" href="/memos">
              <Icon name="file-text" size={20} />
              Memos
            </LinkButton>
            {canSeeAdmin(session.roles) && (
              <LinkButton className={styles.shortcut} variant="tertiary" href="/admin/users/new">
                <Icon name="users" size={20} />
                Add user
              </LinkButton>
            )}
          </div>
        </Panel>
      </div>

      {(approvals !== null || unread.status === 'fulfilled') && (
        <div className={styles.stats}>
          {approvals !== null && (
            <StatCard
              label="Pending approvals"
              value={approvals.length}
              icon="inbox"
              tone={approvals.length > 0 ? 'warning' : 'neutral'}
            />
          )}
          {unread.status === 'fulfilled' && (
            <StatCard label="Unread notifications" value={unread.value.count} icon="bell" />
          )}
        </div>
      )}

      <div className={styles.widgets}>
        {approvals !== null && approvals.length > 0 && (
          <Panel title="Waiting for your decision">
            <Table caption="Pending approvals" minWidth={410}>
              <thead>
                <tr>
                  <Th>Document</Th>
                  <Th>Submitted</Th>
                </tr>
              </thead>
              <tbody>
                {approvals.slice(0, 5).map((item) => (
                  <tr key={item.requestId}>
                    <Td>
                      <CellTitle
                        title={
                          <Link href={`/inbox/${encodeURIComponent(item.requestId)}`}>
                            {item.title}
                          </Link>
                        }
                        meta={item.documentNumber}
                      />
                    </Td>
                    <Td nowrap>
                      <time dateTime={item.submittedAt}>{when(item.submittedAt, 'date')}</time>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        )}
        {notifications.status === 'fulfilled' && (
          <Panel title="Recent notifications">
            {notifications.value.length > 0 ? (
              <ul className={styles.activity}>
                {notifications.value.map((item) => (
                  <li key={item.id}>
                    <span className={styles.activityDot} aria-hidden="true" />
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.body}</p>
                      <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No notifications yet" />
            )}
          </Panel>
        )}
      </div>
    </Page>
  );
}
