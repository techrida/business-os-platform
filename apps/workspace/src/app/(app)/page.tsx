import Link from 'next/link';

import { listActivitiesPage } from '@/components/p2/crm/activities-api';
import { getLeadSummary } from '@/components/p2/crm/leads-api';
import { listOpportunitiesPage } from '@/components/p2/crm/opportunities-api';
import { listCustomers } from '@/components/p2/customers/api';
import { permissionChecker } from '@/components/p2/customers/permissions';
import { getQuotationsSummary, listQuotationsPage } from '@/components/p2/quotations/api';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { Avatar } from '@/components/ui/avatar';
import { LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { getInboxPage, listNotifications } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { getMeOrNull } from '@/lib/live-permissions';
import {
  ACTIVE_OPPORTUNITY_STAGES,
  activityHeadline,
  activityHref,
  greetingFor,
  notificationText,
  openLeadCount,
  quickActions,
} from '@/lib/overview-format';

import styles from './overview.module.css';
import { UnreadStat } from './unread-stat';

/** The reads that let a person see an activity (its subject's read, as in ActivitiesService.list). */
const ACTIVITY_SUBJECT_READS = [
  'customer.read',
  'crm.lead.read',
  'crm.opportunity.read',
  'quotation.read',
] as const;

export default async function OverviewPage() {
  const session = await requireStaffSession('/');
  const numberSystems = await getNumberSystems();
  // Every read stands alone: one that fails or is refused leaves out its own card, never shows a zero.
  const [
    inbox,
    notifications,
    me,
    customers,
    leads,
    opportunities,
    quotationSummary,
    quotations,
    activities,
  ] = await Promise.allSettled([
    getInboxPage(session, { limit: 5 }),
    listNotifications(session, { limit: 5 }),
    // The one `/v1/me` of this render: the layout reads the same memoised call.
    getMeOrNull(session.accessToken),
    listCustomers(session, { limit: 1 }),
    getLeadSummary(session),
    listOpportunitiesPage(session, { stage: ACTIVE_OPPORTUNITY_STAGES, limit: 1 }),
    getQuotationsSummary(session),
    listQuotationsPage(session, { limit: 5, offset: 0 }),
    listActivitiesPage(session, { status: 'logged', limit: 5 }),
  ]);

  // The count is the API's total; the table shows the first five rows.
  const approvals = inbox.status === 'fulfilled' ? inbox.value : null;
  // /v1/me carries the caller's own name (its `userId` is the identity sub, not an app user id).
  const meRead = me.status === 'fulfilled' ? me.value : null;
  const myName = meRead?.displayName ?? undefined;
  // The live grants win over the role defaults, so a revoked permission removes its tile.
  const granted =
    meRead?.permissions !== undefined
      ? new Set<string>(meRead.permissions.map((g) => g.permission))
      : null;
  const allowed =
    granted === null
      ? permissionChecker(session.roles)
      : (permission: string) => granted.has(permission);
  const tiles = quickActions(allowed);
  // The activities list answers 200 with only the rows whose subject the caller may read, so a staff
  // member with none of those reads would see "No activity yet" when the truth is "not yours to see".
  const showActivities = ACTIVITY_SUBJECT_READS.some((permission) => allowed(permission));
  const customerCount =
    customers.status === 'fulfilled' && customers.value.total !== null
      ? customers.value.total
      : null;

  return (
    <Page>
      <PageHeader
        title={greetingFor(new Date(), myName)}
        description="Here’s what needs your attention today."
      />

      <div className={styles.hero}>
        {approvals !== null && (
          <Card as="section" aria-labelledby="overview-approvals" className={styles.nudge}>
            <div>
              <p className={styles.eyebrow}>Your inbox</p>
              <h2 id="overview-approvals">
                {approvals.total === 0
                  ? 'You’re caught up'
                  : `${approvals.total} ${approvals.total === 1 ? 'approval' : 'approvals'} to review`}
              </h2>
            </div>
            <LinkButton className={styles.inboxLink} variant="tertiary" href="/inbox">
              {approvals.total === 0 ? 'Open inbox' : 'Review all'}
              <Icon name="chevron-right" size={16} />
            </LinkButton>
          </Card>
        )}
        {tiles.length > 0 && (
          <Panel className={styles.quickActions} title="Quick actions">
            <div className={styles.shortcuts}>
              {tiles.map((tile) => (
                <LinkButton
                  key={tile.key}
                  className={styles.shortcut}
                  variant="tertiary"
                  href={tile.href}
                >
                  <Icon name={tile.icon} size={20} />
                  {tile.label}
                </LinkButton>
              ))}
            </div>
          </Panel>
        )}
      </div>

      <div className={styles.stats}>
        {customerCount !== null && (
          <StatCard label="Customers" value={customerCount} icon="building" />
        )}
        {leads.status === 'fulfilled' && (
          <StatCard label="Open leads" value={openLeadCount(leads.value.byStage)} icon="target" />
        )}
        {opportunities.status === 'fulfilled' && (
          <StatCard label="Open opportunities" value={opportunities.value.total} icon="briefcase" />
        )}
        {quotationSummary.status === 'fulfilled' && (
          <StatCard
            label="Pending quotations"
            value={quotationSummary.value.byStatus.submitted}
            icon="shield-check"
            tone={quotationSummary.value.byStatus.submitted > 0 ? 'warning' : 'neutral'}
          />
        )}
        {approvals !== null && (
          <StatCard
            label="Pending approvals"
            value={approvals.total}
            icon="inbox"
            tone={approvals.total > 0 ? 'warning' : 'neutral'}
          />
        )}
        <UnreadStat />
      </div>

      {quotations.status === 'fulfilled' && (
        <Panel
          title="Recent quotations"
          actions={
            <LinkButton variant="tertiary" size="small" href="/quotations">
              Explore all
              <Icon name="chevron-right" size={16} />
            </LinkButton>
          }
        >
          {quotations.value.items.length > 0 ? (
            <Table caption="Recent quotations" minWidth={720}>
              <thead>
                <tr>
                  <Th>Quotation</Th>
                  <Th>Organization</Th>
                  <Th align="end">Amount</Th>
                  <Th>Status</Th>
                  <Th>Owner</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {quotations.value.items.map((item) => (
                  <tr key={item.id}>
                    <Td nowrap>
                      <Link href={`/quotations/${encodeURIComponent(item.id)}`}>{item.number}</Link>
                    </Td>
                    <Td>{item.customerName}</Td>
                    <Td align="end" nowrap>
                      {money(item.total, item.currency, numberSystems)}
                    </Td>
                    <Td nowrap>
                      <QuotationStatusBadge status={item.status} />
                    </Td>
                    <Td>
                      {item.ownerName !== null ? (
                        <span className={styles.owner}>
                          <Avatar name={item.ownerName} shape="circle" size="small" />
                          {item.ownerName}
                        </span>
                      ) : (
                        <span className={styles.quiet}>Unassigned</span>
                      )}
                    </Td>
                    <Td nowrap>
                      <time dateTime={item.createdAt}>{when(item.createdAt, 'date')}</time>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState icon="file-text" title="No quotations yet" />
          )}
        </Panel>
      )}

      <div className={styles.widgets}>
        {approvals !== null && approvals.total > 0 && (
          <Panel title="Waiting for your decision">
            <Table caption="Pending approvals" minWidth={410}>
              <thead>
                <tr>
                  <Th>Document</Th>
                  <Th>Submitted</Th>
                </tr>
              </thead>
              <tbody>
                {approvals.items.map((item) => (
                  <tr key={item.requestId}>
                    <Td>
                      <CellTitle
                        title={
                          <Link href={`/inbox/${encodeURIComponent(item.requestId)}`}>
                            {notificationText(item.title)}
                          </Link>
                        }
                        meta={notificationText(item.documentNumber)}
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
        {showActivities && activities.status === 'fulfilled' && (
          <Panel title="Recent activities">
            {activities.value.items.length > 0 ? (
              <ul className={styles.activity}>
                {activities.value.items.map((item) => {
                  const href = activityHref(item);
                  const actor = item.createdByName ?? undefined;
                  return (
                    <li key={item.id}>
                      <span className={styles.activityDot} aria-hidden="true" />
                      <div>
                        <strong>{activityHeadline(item.kind, actor)}</strong>
                        <p>
                          {href !== null ? <Link href={href}>{item.subject}</Link> : item.subject}
                        </p>
                        <time dateTime={item.occurredAt}>{when(item.occurredAt)}</time>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState title="No activity yet" />
            )}
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
                      <strong>{notificationText(item.title)}</strong>
                      <p>{notificationText(item.body)}</p>
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
