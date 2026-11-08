import { ACTIVITY_KINDS, type ActivityDto, type ActivityKind } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listActivities } from '@/components/p2/crm/crm-api';
import styles from '@/components/p2/crm/crm.module.css';
import { ActivityList, ALL_KINDS, LoadProblem } from '@/components/p2/crm/server-bits';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

export const metadata: Metadata = { title: 'Activities · Business OS' };
export const dynamic = 'force-dynamic';

const LIMIT = 100;

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

  let items: ActivityDto[] | null = null;
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
        description="The latest calls, meetings, emails, notes, tasks and stage changes across the CRM. Log one from a lead or an opportunity."
      />

      <form method="get" action="/activities" className={styles.filters} role="search">
        <Field label="Type">
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

      {problem !== null ? (
        <LoadProblem
          status={problem.status}
          message={problem.message}
          what="activities"
          reloadHref={kind ? `/activities?kind=${kind}` : '/activities'}
        />
      ) : items !== null ? (
        <Panel title={kind ? 'Filtered activity' : 'Recent activity'}>
          <ActivityList
            items={items}
            showSubjectLink
            empty={
              kind ? (
                <>
                  Nothing of this type yet. <Link href="/activities">Show all types</Link>.
                </>
              ) : (
                'Open a lead or an opportunity and log a call or a note. It appears here.'
              )
            }
          />
          {items.length >= LIMIT ? (
            <p className={styles.quiet}>Showing the latest {LIMIT}. Filter by type to narrow it.</p>
          ) : null}
        </Panel>
      ) : null}
    </Page>
  );
}
