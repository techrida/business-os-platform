import type { ActivityDto, ActivityKind, ActivityStatus } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listActivities } from '@/components/p2/crm/crm-api';
import {
  ACTIVITY_STATE_TONE,
  activityState,
  ALL_KINDS,
  FILTER_KINDS,
  LoadProblem,
} from '@/components/p2/crm/server-bits';
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
/** `task` is not offered (D39); an old `?kind=task` link falls back to every type. */
const FILTERABLE = new Set<string>(FILTER_KINDS.map((k) => k.value));

interface Loaded {
  items: ActivityDto[];
  problem: { message: string; status: number } | null;
}

/** Earliest due first; the API already sends them so, this keeps the order if it ever does not. */
function byDue(a: ActivityDto, b: ActivityDto): number {
  return (a.dueAt ?? '').localeCompare(b.dueAt ?? '');
}

function ActivityRow({
  activity,
  status,
  now,
}: {
  activity: ActivityDto;
  status: ActivityStatus;
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
    </tr>
  );
}

function ActivityTable({
  status,
  items,
  now,
}: {
  status: ActivityStatus;
  items: ActivityDto[];
  now: Date;
}) {
  const planned = status === 'planned';
  const noun = planned ? 'follow-up' : 'activity';
  const nouns = planned ? 'follow-ups' : 'activities';
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
          </tr>
        </thead>
        <tbody>
          {items.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} status={status} now={now} />
          ))}
        </tbody>
      </Table>
      <p className={styles.footer}>
        {items.length >= LIMIT
          ? `Showing the ${planned ? 'first' : 'latest'} ${LIMIT} ${nouns}. Filter by type to narrow the list.`
          : `Showing ${items.length} ${items.length === 1 ? noun : nouns}`}
      </p>
    </Card>
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
  const kind = FILTERABLE.has(kindValue ?? '') ? (kindValue as ActivityKind) : undefined;
  const reloadHref = kind ? `/activities?kind=${kind}` : '/activities';

  const load = async (status: ActivityStatus): Promise<Loaded> => {
    try {
      const items = await listActivities(session, {
        ...(kind ? { kind } : {}),
        status,
        limit: LIMIT,
      });
      return { items, problem: null };
    } catch (err) {
      const f = failureOf(err);
      return { items: [], problem: { message: f.message, status: f.status } };
    }
  };
  const [planned, logged] = await Promise.all([load('planned'), load('logged')]);
  planned.items.sort(byDue);
  const now = new Date();
  const nothing =
    planned.problem === null &&
    logged.problem === null &&
    planned.items.length === 0 &&
    logged.items.length === 0;

  return (
    <Page>
      <PageHeader
        title="Activities"
        description="Track the calls, meetings, emails and notes on your records, planned and logged."
      />

      <div className={styles.toolbar}>
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
                {FILTER_KINDS.map((k) => (
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

      {nothing ? (
        <EmptyState title="No activity yet" headingLevel={2} icon="inbox">
          {kind ? (
            <>
              Nothing of this type yet. <Link href="/activities">Show all types</Link>.
            </>
          ) : (
            'Log an activity or schedule a follow-up from a lead or an opportunity to see it here.'
          )}
        </EmptyState>
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
              <p className={styles.meta}>No follow-ups planned.</p>
            ) : (
              <ActivityTable status="planned" items={planned.items} now={now} />
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
              <p className={styles.meta}>Nothing logged yet.</p>
            ) : (
              <ActivityTable status="logged" items={logged.items} now={now} />
            )}
          </section>
        </>
      )}
    </Page>
  );
}
