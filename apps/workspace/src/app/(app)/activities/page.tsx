import {
  type ActivityDto,
  type ActivityKind,
  type ActivityStatus,
  DEFAULT_ROWS,
  type LeadOwnerOption,
  type PageWindow,
  pageWindow,
  ROWS_OPTIONS,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { type ActivitiesPage, listActivitiesPage } from '@/components/p2/crm/activities-api';
import { FollowUpActions } from '@/components/p2/crm/follow-ups-card';
import { ListFooter } from '@/components/p2/crm/list-footer';
import { canAssignFollowUps, loadPeople } from '@/components/p2/crm/people';
import {
  ACTIVITY_STATE_TONE,
  activityState,
  ALL_KINDS,
  FILTER_KINDS,
  LoadProblem,
} from '@/components/p2/crm/server-bits';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { getPermissionCheck } from '@/lib/live-permissions';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import styles from './activities.module.css';
import { dueRange } from './due-range';
import { ActivityFilters } from './filters';

export const metadata: Metadata = { title: 'Activities · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/activities';
const SPEC = {
  // `task` is not offered (D39); an old `?kind=task` link is dropped and falls back to every type.
  multi: { kind: FILTER_KINDS.map((k) => k.value) },
  single: { dueFrom: /^\d{4}-\d{2}-\d{2}$/, dueTo: /^\d{4}-\d{2}-\d{2}$/ },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;
const KIND_LABELS = new Map(ALL_KINDS.map(({ value, label }) => [value, label]));
/** Planned follow-ups are one capped list (earliest due first); the logged history is paged. */
const PLANNED_LIMIT = 100;

/** Earliest due first; the API already sends them so, this keeps the order if it ever does not. */
function byDue(x: ActivityDto, y: ActivityDto): number {
  return (x.dueAt ?? '').localeCompare(y.dueAt ?? '');
}

interface Loaded {
  items: ActivityDto[];
  total: number;
  problem: { message: string; status: number } | null;
}

function ActivityRow({
  activity,
  status,
  owners,
  now,
}: {
  activity: ActivityDto;
  status: ActivityStatus;
  owners: readonly LeadOwnerOption[];
  now: Date;
}) {
  const state = activityState(activity, now);
  // Planned rows are timed by when they are due; logged ones by when they were done or happened.
  const at = status === 'planned' ? activity.dueAt : (activity.completedAt ?? activity.occurredAt);
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
          {state ? <Badge tone={ACTIVITY_STATE_TONE[state]}>{state}</Badge> : null}
        </div>
      </Td>
      <Td>{at ? <time dateTime={at}>{when(at)}</time> : null}</Td>
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
      {status === 'planned' ? (
        <Td>
          {/* Any subject (a lead, a deal, a migrated task on a customer) can be finished here, with
              the actions the row's own `can` flags allow. */}
          {activity.planned ? <FollowUpActions item={activity} owners={owners} /> : null}
        </Td>
      ) : null}
    </tr>
  );
}

function ActivityTable({
  status,
  items,
  owners,
  now,
  footer,
}: {
  status: ActivityStatus;
  items: ActivityDto[];
  owners: readonly LeadOwnerOption[];
  now: Date;
  footer: ReactNode;
}) {
  const planned = status === 'planned';
  return (
    <Card className={styles.results}>
      <Table
        caption={planned ? 'Planned follow-ups' : 'Logged activities'}
        minWidth={560}
        className={styles.table ?? ''}
      >
        <thead>
          <tr>
            <Th>Activity</Th>
            <Th>Type</Th>
            <Th>{planned ? 'Due' : 'Logged'}</Th>
            <Th>Linked record</Th>
            {planned ? <Th>Actions</Th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              status={status}
              owners={owners}
              now={now}
            />
          ))}
        </tbody>
      </Table>
      {footer}
    </Card>
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
  const due = dueRange(state.single.dueFrom, state.single.dueTo);
  const filtered =
    q !== undefined || kinds.length > 0 || due.dueFrom !== undefined || due.dueTo !== undefined;
  const filters = { ...(q !== undefined ? { q } : {}), kind: kinds, ...due };
  const reloadHref = hrefWith(PATH, sp, { page: state.page > 1 ? state.page : null });

  const loadPlanned = async (): Promise<Loaded> => {
    try {
      const page = await listActivitiesPage(session, {
        ...filters,
        status: 'planned',
        limit: PLANNED_LIMIT,
      });
      return { ...page, items: [...page.items].sort(byDue), problem: null };
    } catch (err) {
      const f = failureOf(err);
      return { items: [], total: 0, problem: { message: f.message, status: f.status } };
    }
  };
  const loadLogged = async (): Promise<Loaded & { pageInfo: PageWindow }> => {
    let pageInfo = pageWindow(state.page, state.rows);
    const read = (window: { limit: number; offset: number }): Promise<ActivitiesPage> =>
      listActivitiesPage(session, { ...filters, status: 'logged', ...window });
    try {
      let page = await read(pageInfo);
      pageInfo = pageWindow(pageInfo.page, pageInfo.limit, page.total);
      if (page.items.length === 0 && page.total > 0) {
        // The URL named a page past the end: show the last one instead of an empty table.
        page = await read(pageInfo);
      }
      return { ...page, pageInfo, problem: null };
    } catch (err) {
      const f = failureOf(err);
      return {
        items: [],
        total: 0,
        pageInfo,
        problem: { message: f.message, status: f.status },
      };
    }
  };
  // The owners list (Reschedule's choices) needs crm.lead.write; without it Reschedule keeps the
  // current assignee. Names on the rows come from the activities themselves (D46).
  const [planned, logged, people] = await Promise.all([
    loadPlanned(),
    loadLogged(),
    canAssignFollowUps(session)
      .then((owners) => loadPeople(session, { owners }))
      .catch(() => null),
  ]);
  const owners = people?.owners ?? [];
  const can = await getPermissionCheck(session);
  // The empty state tells only someone who may log one where to do it.
  const mayLog = can('crm.lead.write') || can('crm.opportunity.write');
  const now = new Date();
  const problem = planned.problem ?? logged.problem;
  const shown = planned.items.length + logged.items.length;
  const total = planned.total + logged.total;
  const nothing = problem === null && total === 0;
  const hiding = activeFilterLabels(
    { q, multi: { kind: kinds }, single: { dueFrom: due.dueFrom, dueTo: due.dueTo } },
    {
      kind: { label: 'Type', format: (v) => KIND_LABELS.get(v as ActivityKind) ?? v },
      dueFrom: { label: 'Due from', format: (v) => when(v, 'date') },
      dueTo: { label: 'Due to', format: (v) => when(v, 'date') },
    },
  );

  return (
    <Page>
      <PageHeader
        title="Activities"
        description="Track the calls, meetings, emails and notes on your records, planned and logged."
      />

      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <ActivityFilters
            rows={state.rows}
            kinds={kinds}
            kindOptions={FILTER_KINDS}
            dueFrom={due.dueFrom ?? ''}
            dueTo={due.dueTo ?? ''}
          />
          {problem === null ? (
            <ResultCount shown={shown} total={total} noun="activity" plural="activities" />
          ) : null}
        </div>
      </div>

      {nothing ? (
        filtered ? (
          <EmptyState
            title="No activities match"
            headingLevel={2}
            icon="inbox"
            action={<Link href={clearFiltersHref(PATH, sp, SPEC)}>Clear filters</Link>}
          >
            Nothing matches {hiding.join(', ')}.
          </EmptyState>
        ) : (
          <EmptyState title="No calls, meetings, emails or notes yet" headingLevel={2} icon="inbox">
            {mayLog
              ? 'Open a lead or an opportunity, then log an activity or schedule a follow-up. It shows here.'
              : 'Activities logged on the leads and opportunities you can see show here.'}
          </EmptyState>
        )
      ) : (
        <>
          <section aria-labelledby="activity-planned" className={styles.list}>
            <h2 id="activity-planned" className={styles.sectionTitle}>
              Planned
            </h2>
            {planned.problem !== null ? (
              <LoadProblem
                status={planned.problem.status}
                message={planned.problem.message}
                what="planned follow-ups"
                reloadHref={reloadHref}
              />
            ) : planned.items.length === 0 ? (
              <p className={styles.meta}>
                {filtered ? 'No follow-ups match.' : 'No follow-ups planned.'}
              </p>
            ) : (
              <ActivityTable
                status="planned"
                items={planned.items}
                owners={owners}
                now={now}
                footer={
                  <p className={styles.footer}>
                    {planned.total > planned.items.length
                      ? `Showing the first ${planned.items.length} of ${planned.total} follow-ups. Filter to narrow the list.`
                      : `Showing ${planned.items.length} ${planned.items.length === 1 ? 'follow-up' : 'follow-ups'}`}
                  </p>
                }
              />
            )}
          </section>

          <section aria-labelledby="activity-logged" className={styles.list}>
            <h2 id="activity-logged" className={styles.sectionTitle}>
              Logged
            </h2>
            {logged.problem !== null ? (
              <LoadProblem
                status={logged.problem.status}
                message={logged.problem.message}
                what="logged activities"
                reloadHref={reloadHref}
              />
            ) : logged.items.length === 0 ? (
              <p className={styles.meta}>
                {filtered ? 'No logged activities match.' : 'Nothing logged yet.'}
              </p>
            ) : (
              <ActivityTable
                status="logged"
                items={logged.items}
                owners={owners}
                now={now}
                footer={
                  <ListFooter
                    label="Activity pages"
                    pathname={PATH}
                    params={sp}
                    pageInfo={logged.pageInfo}
                    total={logged.total}
                    noun="activity"
                    plural="activities"
                    rowsOptions={ROWS_OPTIONS}
                  />
                }
              />
            )}
          </section>
        </>
      )}
    </Page>
  );
}
