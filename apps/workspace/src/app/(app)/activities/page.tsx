import {
  ACTIVITY_KINDS,
  type ActivityDto,
  type ActivityKind,
  DEFAULT_ROWS,
  pageWindow,
  ROWS_OPTIONS,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { type ActivitiesPage, listActivitiesPage } from '@/components/p2/crm/activities-api';
import { ListFooter } from '@/components/p2/crm/list-footer';
import { ALL_KINDS, LoadProblem } from '@/components/p2/crm/server-bits';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import styles from './activities.module.css';
import { ActivityFilters } from './filters';

export const metadata: Metadata = { title: 'Activities · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/activities';
const SPEC = {
  multi: { kind: ACTIVITY_KINDS },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;
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
  searchParams: Promise<RawParams>;
}) {
  const session = await requireStaffSession(PATH);
  const sp = await searchParams;
  const state = readList(sp, SPEC);
  const kinds = state.multi.kind as ActivityKind[];
  const { q } = state;
  const filtered = q !== undefined || kinds.length > 0;
  const filters = { ...(q !== undefined ? { q } : {}), kind: kinds };

  let result: ActivitiesPage | null = null;
  let pageInfo = pageWindow(state.page, state.rows);
  let problem: { message: string; status: number } | null = null;
  try {
    result = await listActivitiesPage(session, {
      ...filters,
      limit: pageInfo.limit,
      offset: pageInfo.offset,
    });
    pageInfo = pageWindow(pageInfo.page, pageInfo.limit, result.total);
    if (result.items.length === 0 && result.total > 0) {
      // The URL named a page past the end: show the last one instead of an empty table.
      result = await listActivitiesPage(session, {
        ...filters,
        limit: pageInfo.limit,
        offset: pageInfo.offset,
      });
    }
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const items = result?.items ?? [];
  const total = result?.total ?? 0;
  const hiding = activeFilterLabels(
    { q, multi: { kind: kinds }, single: {} },
    { kind: { label: 'Type', format: (v) => KIND_LABELS.get(v as ActivityKind) ?? v } },
  );

  return (
    <Page>
      <PageHeader
        title="Activities"
        description="Track calls, meetings, notes and tasks logged against your records."
      />

      <section aria-labelledby="activity-list" className={styles.list}>
        <div className={styles.toolbar}>
          <h2 id="activity-list">Recent activity</h2>
          <div className={styles.filters}>
            <ActivityFilters rows={state.rows} kinds={kinds} kindOptions={ALL_KINDS} />
            {problem === null ? (
              <ResultCount shown={items.length} total={total} noun="activity" plural="activities" />
            ) : null}
          </div>
        </div>
        {problem !== null ? (
          <LoadProblem
            status={problem.status}
            message={problem.message}
            what="activities"
            reloadHref={hrefWith(PATH, sp, { page: state.page > 1 ? state.page : null })}
          />
        ) : items.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No activities match"
              headingLevel={3}
              icon="inbox"
              action={<Link href={clearFiltersHref(PATH, sp, SPEC)}>Clear filters</Link>}
            >
              Nothing matches {hiding.join(', ')}.
            </EmptyState>
          ) : (
            <EmptyState title="No activity yet" headingLevel={3} icon="inbox">
              Log an activity from a lead or an opportunity to see it here.
            </EmptyState>
          )
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
            <ListFooter
              label="Activity pages"
              pathname={PATH}
              params={sp}
              pageInfo={pageInfo}
              total={total}
              noun="activity"
              plural="activities"
              rowsOptions={ROWS_OPTIONS}
            />
          </Card>
        )}
      </section>
    </Page>
  );
}
