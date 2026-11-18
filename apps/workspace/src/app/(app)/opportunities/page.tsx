import { OPPORTUNITY_STAGES, type OpportunityDto, type OpportunityStage } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Board } from '@/components/p2/crm/board';
import { listOpportunities } from '@/components/p2/crm/crm-api';
import { moneyOrNull } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge, ViewSwitch } from '@/components/p2/crm/server-bits';
import styles from '@/components/p2/crm/crm.module.css';
import { OpportunityFilters } from '@/components/p2/crm/stage-filter';
import { boardColumns, groupByStage, stageLabel, userMoves } from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { moveOpportunityStageAction } from './actions';

export const metadata: Metadata = { title: 'Opportunities · Business OS' };
export const dynamic = 'force-dynamic';

const LIMIT = 200;
type Search = { view?: string | string[]; q?: string | string[]; stage?: string | string[] };

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function href({
  view,
  q,
  stages = [],
}: {
  view?: 'table' | 'board';
  q?: string | undefined;
  stages?: readonly OpportunityStage[];
}) {
  const params = new URLSearchParams();
  if (view === 'board') params.set('view', view);
  if (q) params.set('q', q);
  for (const stage of stages) params.append('stage', stage);
  return params.size > 0 ? `/opportunities?${params.toString()}` : '/opportunities';
}

const stageOptions = OPPORTUNITY_STAGES.map((value) => ({
  value,
  label: stageLabel('opportunity', value),
}));

function columnsFor(items: OpportunityDto[]): BoardColumnData[] {
  const groups = groupByStage('opportunity', items);
  return boardColumns('opportunity').map((c) => ({
    stage: c.stage,
    label: c.label,
    note: c.note,
    cards: (groups.get(c.stage) ?? []).map((o) => ({
      id: o.id,
      href: `/opportunities/${o.id}`,
      title: o.name,
      number: o.number,
      subtitle: o.expectedClose ? `Expected close ${when(o.expectedClose, 'date')}` : '',
      value: moneyOrNull(o.value, o.currency),
      version: o.version,
      moves: userMoves('opportunity', o.stage),
    })),
  }));
}

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const session = await requireStaffSession('/opportunities');
  const sp = await searchParams;
  const view = one(sp.view) === 'board' ? 'board' : 'table';
  const q = one(sp.q)?.trim().slice(0, 100) || undefined;
  const requestedStages = new Set(Array.isArray(sp.stage) ? sp.stage : [sp.stage]);
  const stages = OPPORTUNITY_STAGES.filter((stage) => requestedStages.has(stage));
  const hasStageFilter = view === 'table' && stages.length > 0;
  const filtered = q !== undefined || hasStageFilter;

  let items: OpportunityDto[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listOpportunities(session, {
      ...(q !== undefined ? { q } : {}),
      ...(hasStageFilter ? { stage: stages } : {}),
      limit: LIMIT,
    });
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  return (
    <Page>
      <PageHeader
        title="Opportunities"
        description="Qualified deals on their way to a quotation. Quotation Sent and Won are set by the system as quotations are sent and accepted."
      />

      <div className={styles.toolbar}>
        <OpportunityFilters view={view} query={q ?? ''} selection={stages} options={stageOptions} />
        <ViewSwitch
          current={view}
          hrefs={{
            table: href({ q, stages }),
            board: href({ view: 'board', q, stages }),
          }}
        />
      </div>

      {problem !== null ? (
        <LoadProblem
          status={problem.status}
          message={problem.message}
          what="opportunities"
          reloadHref={href({ view, q, stages })}
        />
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No opportunities match"
            action={
              hasStageFilter ? (
                <Link href={href({ q })}>Clear stages</Link>
              ) : (
                <Link href={href({ view, stages })}>Clear search</Link>
              )
            }
          >
            {hasStageFilter ? 'Try fewer words or another stage.' : 'Try fewer or different words.'}
          </EmptyState>
        ) : (
          <EmptyState title="No opportunities yet">
            Convert a Qualified lead and its opportunity appears here.
          </EmptyState>
        )
      ) : items !== null && view === 'board' ? (
        <Board columns={columnsFor(items)} action={moveOpportunityStageAction} noun="opportunity" />
      ) : items !== null ? (
        <Table caption="Opportunities" minWidth={720}>
          <thead>
            <tr>
              <Th>Opportunity</Th>
              <Th>Stage</Th>
              <Th align="end">Value</Th>
              <Th align="end">Probability</Th>
              <Th>Expected close</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <Td>
                  <CellTitle
                    title={<Link href={`/opportunities/${o.id}`}>{o.name}</Link>}
                    meta={
                      <>
                        <span className="sr-only">Opportunity number: </span>
                        {o.number}
                      </>
                    }
                  />
                </Td>
                <Td nowrap>
                  <StageBadge kind="opportunity" stage={o.stage} />
                </Td>
                <Td align="end" nowrap>
                  {moneyOrNull(o.value, o.currency) ?? (
                    <span className={styles.quiet}>Not set</span>
                  )}
                </Td>
                <Td align="end" nowrap>
                  {o.probability !== null ? (
                    `${o.probability}%`
                  ) : (
                    <span className={styles.quiet}>Not set</span>
                  )}
                </Td>
                <Td nowrap>
                  {o.expectedClose ? (
                    <time dateTime={o.expectedClose}>{when(o.expectedClose, 'date')}</time>
                  ) : (
                    <span className={styles.quiet}>Not set</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      {items !== null && items.length >= LIMIT ? (
        <p className={styles.quiet}>
          Showing the first {LIMIT} opportunities.{' '}
          {view === 'table'
            ? 'Search or filter by stage to narrow the list.'
            : 'Search to narrow the board.'}
        </p>
      ) : null}
    </Page>
  );
}
