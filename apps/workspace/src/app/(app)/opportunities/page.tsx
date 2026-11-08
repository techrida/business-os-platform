import { OPPORTUNITY_STAGES, type OpportunityDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Board } from '@/components/p2/crm/board';
import { listOpportunities } from '@/components/p2/crm/crm-api';
import { moneyOrNull } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge, ViewSwitch } from '@/components/p2/crm/server-bits';
import styles from '@/components/p2/crm/crm.module.css';
import { boardColumns, groupByStage, stageLabel, userMoves } from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
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

function href(params: { view?: string; q?: string; stage?: string }): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q.size > 0 ? `/opportunities?${q.toString()}` : '/opportunities';
}

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
  const stageParam = one(sp.stage);
  const stage = (OPPORTUNITY_STAGES as readonly string[]).includes(stageParam ?? '')
    ? stageParam
    : undefined;
  const filtered = q !== undefined || (view === 'table' && stage !== undefined);

  let items: OpportunityDto[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listOpportunities(session, {
      ...(q !== undefined ? { q } : {}),
      ...(view === 'table' && stage !== undefined ? { stage } : {}),
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
        <form method="get" action="/opportunities" className={styles.filters} role="search">
          {view === 'board' ? <input type="hidden" name="view" value="board" /> : null}
          <Field label="Search opportunities">
            {(c) => <Input name="q" type="search" defaultValue={q ?? ''} maxLength={100} {...c} />}
          </Field>
          {view === 'table' ? (
            <Field label="Stage">
              {(c) => (
                <Select name="stage" defaultValue={stage ?? ''} {...c}>
                  <option value="">All stages</option>
                  {OPPORTUNITY_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {stageLabel('opportunity', s)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
        <ViewSwitch
          current={view}
          hrefs={{
            table: href({ ...(q ? { q } : {}), ...(stage ? { stage } : {}) }),
            board: href({ view: 'board', ...(q ? { q } : {}) }),
          }}
        />
      </div>

      {problem !== null ? (
        <LoadProblem
          status={problem.status}
          message={problem.message}
          what="opportunities"
          reloadHref={href({ view, ...(q ? { q } : {}) })}
        />
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState
            title="No opportunities match"
            action={<Link href="/opportunities">Clear the search</Link>}
          >
            Try fewer words or another stage.
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
          Showing the first {LIMIT} opportunities. Search or filter by stage to narrow the list.
        </p>
      ) : null}
    </Page>
  );
}
