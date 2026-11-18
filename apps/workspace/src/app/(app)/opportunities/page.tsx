import { OPPORTUNITY_STAGES, type OpportunityDto, type OpportunityStage } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Board } from '@/components/p2/crm/board';
import { listOpportunities } from '@/components/p2/crm/crm-api';
import { moneyOrNull } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge } from '@/components/p2/crm/server-bits';
import { OpportunityFilters } from '@/components/p2/crm/stage-filter';
import { boardColumns, groupByStage, stageLabel, userMoves } from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { moveOpportunityStageAction } from './actions';
import styles from './opportunities.module.css';

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

function PipelineSummary({ items }: { items: readonly OpportunityDto[] }) {
  const counts = { active: 0, qualified: 0, negotiation: 0, on_hold: 0, won: 0 };
  for (const { stage } of items) {
    if (stage !== 'lost' && stage !== 'won' && stage !== 'on_hold') counts.active++;
    if (
      stage === 'qualified' ||
      stage === 'negotiation' ||
      stage === 'on_hold' ||
      stage === 'won'
    ) {
      counts[stage]++;
    }
  }

  return (
    <section className={styles.metrics} aria-label="Pipeline summary">
      <StatCard label="Active pipeline" value={counts.active} icon="briefcase" />
      <StatCard label="Qualified" value={counts.qualified} icon="target" />
      <StatCard label="Negotiation" value={counts.negotiation} icon="trending-up" />
      <StatCard label="On hold" value={counts.on_hold} icon="info" tone="warning" />
      <StatCard label="Won" value={counts.won} icon="check-circle" tone="success" />
    </section>
  );
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
        description="Track qualified deals from discovery through quotation and close."
      />

      {items !== null && items.length < LIMIT && !filtered ? (
        <PipelineSummary items={items} />
      ) : null}

      <div className={styles.toolbar}>
        <OpportunityFilters view={view} query={q ?? ''} selection={stages} options={stageOptions} />
        <nav aria-label="View" className={styles.views}>
          <Link href={href({ q, stages })} aria-current={view === 'table' ? 'page' : undefined}>
            <Icon name="list-checks" size={16} />
            Table
          </Link>
          <Link
            href={href({ view: 'board', q, stages })}
            aria-current={view === 'board' ? 'page' : undefined}
          >
            <Icon name="kanban" size={16} />
            Board
          </Link>
        </nav>
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
        <Board
          columns={columnsFor(items)}
          action={moveOpportunityStageAction}
          noun="opportunity"
          className={styles.board}
        />
      ) : items !== null ? (
        <Table caption="Opportunities" minWidth={740} className={styles.listTable}>
          <thead>
            <tr>
              <Th>Opportunity</Th>
              <Th>Stage</Th>
              <Th align="end">Value</Th>
              <Th align="end">Probability</Th>
              <Th>Expected close</Th>
              <Th>Quick action</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id} data-won={o.stage === 'won' || undefined}>
                <Td>
                  <CellTitle
                    title={<Link href={`/opportunities/${o.id}`}>{o.name}</Link>}
                    note={
                      <span className={styles.recordNumber}>
                        <span className="sr-only">Opportunity number: </span>
                        {o.number}
                      </span>
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
                <Td nowrap>
                  <Link href={`/opportunities/${o.id}`} className={styles.rowAction}>
                    View details<span className="sr-only"> for {o.number}</span>
                    <Icon name="chevron-right" size={16} />
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={6} className={styles.tableSummary}>
                {items.length >= LIMIT ? `Showing the first ${LIMIT}` : `Showing ${items.length}`}{' '}
                {items.length === 1 ? 'opportunity' : 'opportunities'}
              </Td>
            </tr>
          </tfoot>
        </Table>
      ) : null}

      {items !== null && view === 'board' && items.length >= LIMIT ? (
        <p className={styles.quiet}>
          Showing the first {LIMIT} opportunities. Search to narrow the board.
        </p>
      ) : null}
    </Page>
  );
}
