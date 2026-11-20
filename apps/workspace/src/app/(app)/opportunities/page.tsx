import {
  DEFAULT_ROWS,
  OPPORTUNITY_STAGES,
  type OpportunityDto,
  pageWindow,
  ROWS_OPTIONS,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { Board } from '@/components/p2/crm/board';
import { ownerFilterNames } from '@/components/p2/crm/crm-api';
import { ListFooter } from '@/components/p2/crm/list-footer';
import {
  listOpportunitiesPage,
  type OpportunitiesPage,
} from '@/components/p2/crm/opportunities-api';
import { moneyOrNull } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge } from '@/components/p2/crm/server-bits';
import { boardColumns, boardMoves, groupByStage, stageLabel } from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';
import type { Session } from '@/lib/session';

import { moveOpportunityStageAction } from './actions';
import { OpportunityFilters } from './filters';
import styles from './opportunities.module.css';

export const metadata: Metadata = { title: 'Opportunities · Business OS' };
export const dynamic = 'force-dynamic';

const BOARD_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = '/opportunities';
const ROWS = { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS };

const stageOptions = OPPORTUNITY_STAGES.map((value) => ({
  value,
  label: stageLabel('opportunity', value),
}));

function columnsFor(items: OpportunityDto[], numberSystems: NumberSystems): BoardColumnData[] {
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
      value: moneyOrNull(o.value, o.currency, numberSystems),
      version: o.version,
      moves: boardMoves('opportunity', o),
    })),
  }));
}

type Counts = {
  active: number;
  qualified: number;
  negotiation: number;
  on_hold: number;
  won: number;
};

const ACTIVE_STAGES = OPPORTUNITY_STAGES.filter(
  (stage) => stage !== 'lost' && stage !== 'won' && stage !== 'on_hold',
);

/** Counts come from the API's total (one cheap request per card), not from the rows on this page. */
async function loadCounts(session: Session): Promise<Counts | null> {
  const count = async (stage: readonly string[]) =>
    (await listOpportunitiesPage(session, { stage, limit: 1 })).total;
  try {
    const [active, qualified, negotiation, on_hold, won] = await Promise.all([
      count(ACTIVE_STAGES),
      count(['qualified']),
      count(['negotiation']),
      count(['on_hold']),
      count(['won']),
    ]);
    return { active, qualified, negotiation, on_hold, won };
  } catch {
    // The cards are a courtesy; the list below reports its own failure.
    return null;
  }
}

function PipelineSummary({ counts }: { counts: Counts }) {
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
  searchParams: Promise<RawParams>;
}) {
  const session = await requireStaffSession(PATH);
  const numberSystems = await getNumberSystems();
  const sp = await searchParams;
  const names = await ownerFilterNames(session, 'opportunities');
  const ownerOptions = [...names]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const view = readList(sp, { search: false, single: { view: ['table', 'board'] } }).single.view;
  const board = view === 'board';
  // Without the user directory there is no owner control, so an owner param is not applied either.
  const spec = {
    multi: { stage: OPPORTUNITY_STAGES, owner: ownerOptions.length > 0 ? UUID : [] },
    rows: ROWS,
  } as const;
  const state = readList(sp, spec);
  // The board has no stage filter: its columns are the stages.
  const stages = board ? [] : state.multi.stage;
  const owners = state.multi.owner;
  const { q } = state;
  const filtered = q !== undefined || stages.length > 0 || owners.length > 0;
  const filters = { ...(q !== undefined ? { q } : {}), stage: stages, owner: owners };

  let result: OpportunitiesPage | null = null;
  let pageInfo = pageWindow(board ? 1 : state.page, board ? BOARD_LIMIT : state.rows);
  let problem: { message: string; status: number } | null = null;
  try {
    result = await listOpportunitiesPage(session, {
      ...filters,
      limit: pageInfo.limit,
      offset: pageInfo.offset,
    });
    pageInfo = pageWindow(pageInfo.page, pageInfo.limit, result.total);
    if (result.items.length === 0 && result.total > 0) {
      // The URL named a page past the end: show the last one instead of an empty table.
      result = await listOpportunitiesPage(session, {
        ...filters,
        limit: pageInfo.limit,
        offset: pageInfo.offset,
      });
    }
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const items = result?.items ?? null;
  const total = result?.total ?? 0;
  const counts = !filtered && problem === null ? await loadCounts(session) : null;
  const viewHref = (next: 'table' | 'board') =>
    hrefWith(PATH, sp, { view: next === 'board' ? 'board' : null, page: null });
  const hiding = activeFilterLabels(
    { q, multi: { stage: stages, owner: owners }, single: {} },
    {
      stage: { label: 'Stage', format: (v) => stageLabel('opportunity', v) },
      owner: { label: 'Owner', format: (v) => names.get(v) ?? 'Selected owner' },
    },
  );

  return (
    <Page>
      <PageHeader
        title="Opportunities"
        description="Track qualified deals from discovery through quotation and close."
      />

      {counts !== null ? <PipelineSummary counts={counts} /> : null}

      <div className={styles.toolbar}>
        <OpportunityFilters
          view={board ? 'board' : 'table'}
          rows={state.rows}
          stages={stages}
          owners={owners}
          stageOptions={stageOptions}
          ownerOptions={ownerOptions}
        />
        <nav aria-label="View" className={styles.views}>
          <Link href={viewHref('table')} aria-current={board ? undefined : 'page'}>
            <Icon name="list-checks" size={16} />
            Table
          </Link>
          <Link href={viewHref('board')} aria-current={board ? 'page' : undefined}>
            <Icon name="kanban" size={16} />
            Board
          </Link>
        </nav>
        {items !== null ? (
          <ResultCount
            shown={items.length}
            total={total}
            noun="opportunity"
            plural="opportunities"
          />
        ) : null}
      </div>

      {problem !== null ? (
        <LoadProblem
          status={problem.status}
          message={problem.message}
          what="opportunities"
          reloadHref={hrefWith(PATH, sp, { page: state.page > 1 ? state.page : null })}
        />
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No opportunities match"
            action={<Link href={clearFiltersHref(PATH, sp, spec)}>Clear filters</Link>}
          >
            Nothing matches {hiding.join(', ')}.
          </EmptyState>
        ) : (
          <EmptyState title="No opportunities yet">
            Convert a Qualified lead and its opportunity appears here.
          </EmptyState>
        )
      ) : items !== null && board ? (
        <Board
          columns={columnsFor(items, numberSystems)}
          action={moveOpportunityStageAction}
          noun="opportunity"
          className={styles.board}
        />
      ) : items !== null ? (
        <Table caption="Opportunities" minWidth={740} className={styles.listTable ?? ''}>
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
                  {moneyOrNull(o.value, o.currency, numberSystems) ?? (
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
        </Table>
      ) : null}

      {items !== null && items.length > 0 && !board ? (
        <ListFooter
          label="Opportunity pages"
          pathname={PATH}
          params={sp}
          pageInfo={pageInfo}
          total={total}
          noun="opportunity"
          plural="opportunities"
          rowsOptions={ROWS_OPTIONS}
        />
      ) : null}

      {items !== null && board && total > BOARD_LIMIT ? (
        <p className={styles.quiet}>
          Showing the first {BOARD_LIMIT} of {total} opportunities. Search to narrow the board.
        </p>
      ) : null}
    </Page>
  );
}
