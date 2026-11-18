import { ACTIVITY_KINDS, type ActivityDto, type ActivityKind } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listActivities } from '@/components/p2/crm/crm-api';
import { ALL_KINDS, LoadProblem } from '@/components/p2/crm/server-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import styles from './activities.module.css';

export const metadata: Metadata = { title: 'Activities · Business OS' };
export const dynamic = 'force-dynamic';

const LIMIT = 100;
const KIND_LABELS = new Map(ALL_KINDS.map(({ value, label }) => [value, label]));

function ActivityRow({ activity }: { activity: ActivityDto }) {
  return (
    <tr>
      <Td className={styles.activity}>
        <CellTitle
          title={activity.subject}
          note={activity.body ? <span className={styles.details}>{activity.body}</span> : null}
        />
      </Td>
      <Td>
        <div className={styles.tags}>
          <Badge tone="neutral">{KIND_LABELS.get(activity.kind) ?? activity.kind}</Badge>
          {activity.completedAt ? <Badge tone="success">Done</Badge> : null}
        </div>
      </Td>
      <Td>
        <time dateTime={activity.occurredAt}>{when(activity.occurredAt)}</time>
        {activity.dueAt && !activity.completedAt ? (
          <div className={styles.meta}>
            Due <time dateTime={activity.dueAt}>{when(activity.dueAt)}</time>
          </div>
        ) : null}
      </Td>
      <Td nowrap>
        {activity.leadId ? (
          <Link className={styles.recordLink} href={`/leads/${activity.leadId}`}>
            Open lead
          </Link>
        ) : activity.opportunityId ? (
          <Link className={styles.recordLink} href={`/opportunities/${activity.opportunityId}`}>
            Open opportunity
          </Link>
        ) : (
          <span className={styles.meta}>—</span>
        )}
      </Td>
    </tr>
  );
}

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string | string[] }>;
}) {
  const session = await requireStaffSession('/activities');
  const { kind: kindParam } = await searchParams;
  const kindValue = typeof kindParam === 'string' ? kindParam : undefined;
  const kind = (ACTIVITY_KINDS as readonly string[]).includes(kindValue ?? '')
    ? (kindValue as ActivityKind)
    : undefined;

  let items: ActivityDto[] = [];
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listActivities(session, { ...(kind ? { kind } : {}), limit: LIMIT });
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  return (
    <Page>
      <PageHeader
        title="Activities"
        description="Track calls, meetings, notes and tasks logged against your records."
      />

      <section aria-labelledby="activity-list" className={styles.list}>
        <div className={styles.toolbar}>
          <h2 id="activity-list">Recent activity</h2>
          <form
            method="get"
            action="/activities"
            className={styles.filters}
            role="search"
            aria-label="Filter activities"
          >
            <Field label="Type" className={styles.typeField ?? ''}>
              {(c) => (
                <Select name="kind" defaultValue={kind ?? ''} {...c}>
                  <option value="">All types</option>
                  {ALL_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </form>
        </div>
        {problem !== null ? (
          <LoadProblem
            status={problem.status}
            message={problem.message}
            what="activities"
            reloadHref={kind ? `/activities?kind=${kind}` : '/activities'}
          />
        ) : items.length === 0 ? (
          <EmptyState title="No activity yet" headingLevel={3} icon="inbox">
            {kind ? (
              <>
                Nothing of this type yet. <Link href="/activities">Show all types</Link>.
              </>
            ) : (
              'Log an activity from a lead or an opportunity to see it here.'
            )}
          </EmptyState>
        ) : (
          <Card className={styles.results}>
            <Table caption="Recent activities" minWidth={560} className={styles.table ?? ''}>
              <thead>
                <tr>
                  <Th>Activity</Th>
                  <Th>Type</Th>
                  <Th>Logged</Th>
                  <Th>Linked record</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((activity) => (
                  <ActivityRow key={activity.id} activity={activity} />
                ))}
              </tbody>
            </Table>
            <p className={styles.footer}>
              {items.length >= LIMIT
                ? `Showing the latest ${LIMIT} activities. Filter by type to narrow the list.`
                : `Showing ${items.length} ${items.length === 1 ? 'activity' : 'activities'}`}
            </p>
          </Card>
        )}
      </section>
    </Page>
  );
}
