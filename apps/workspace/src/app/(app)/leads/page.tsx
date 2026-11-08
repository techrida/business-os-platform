import { LEAD_STAGES, type LeadDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Board } from '@/components/p2/crm/board';
import { listLeads } from '@/components/p2/crm/crm-api';
import { moneyOrNull, sentence } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge, ViewSwitch } from '@/components/p2/crm/server-bits';
import styles from '@/components/p2/crm/crm.module.css';
import { boardColumns, groupByStage, stageLabel, userMoves } from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { moveLeadStageAction } from './actions';

export const metadata: Metadata = { title: 'Leads · Business OS' };
export const dynamic = 'force-dynamic';

const LIMIT = 200;
type Search = { view?: string | string[]; q?: string | string[]; stage?: string | string[] };

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined;

function href(params: { view?: string; q?: string; stage?: string }): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return q.size > 0 ? `/leads?${q.toString()}` : '/leads';
}

function columnsFor(leads: LeadDto[]): BoardColumnData[] {
  const groups = groupByStage('lead', leads);
  return boardColumns('lead').map((c) => ({
    stage: c.stage,
    label: c.label,
    note: c.note,
    cards: (groups.get(c.stage) ?? []).map((l) => ({
      id: l.id,
      href: `/leads/${l.id}`,
      title: l.title,
      number: l.number,
      subtitle: `${l.companyName} · ${l.contactName}`,
      value: moneyOrNull(l.expectedValue, l.currency),
      version: l.version,
      moves: userMoves('lead', l.stage),
    })),
  }));
}

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffSession('/leads');
  const sp = await searchParams;
  const view = one(sp.view) === 'board' ? 'board' : 'table';
  const q = one(sp.q)?.trim().slice(0, 100) || undefined;
  const stageParam = one(sp.stage);
  const stage = (LEAD_STAGES as readonly string[]).includes(stageParam ?? '')
    ? stageParam
    : undefined;
  const filtered = q !== undefined || (view === 'table' && stage !== undefined);

  let leads: LeadDto[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    leads = await listLeads(session, {
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
        title="Leads"
        description="Every enquiry from first contact to conversion. Open a lead to log activity, move its stage or convert it."
        actions={<LinkButton href="/leads/new">New lead</LinkButton>}
      />

      <div className={styles.toolbar}>
        <form method="get" action="/leads" className={styles.filters} role="search">
          {view === 'board' ? <input type="hidden" name="view" value="board" /> : null}
          <Field label="Search leads">
            {(c) => <Input name="q" type="search" defaultValue={q ?? ''} maxLength={100} {...c} />}
          </Field>
          {view === 'table' ? (
            <Field label="Stage">
              {(c) => (
                <Select name="stage" defaultValue={stage ?? ''} {...c}>
                  <option value="">All stages</option>
                  {LEAD_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {stageLabel('lead', s)}
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
          what="leads"
          reloadHref={href({ view, ...(q ? { q } : {}) })}
        />
      ) : leads !== null && leads.length === 0 ? (
        filtered ? (
          <EmptyState title="No leads match" action={<Link href="/leads">Clear the search</Link>}>
            Try fewer words or another stage.
          </EmptyState>
        ) : (
          <EmptyState
            title="No leads yet"
            action={<LinkButton href="/leads/new">New lead</LinkButton>}
          >
            Website enquiries arrive here by themselves. Add one by hand for a call or a walk-in.
          </EmptyState>
        )
      ) : leads !== null && view === 'board' ? (
        <Board columns={columnsFor(leads)} action={moveLeadStageAction} noun="lead" />
      ) : leads !== null ? (
        <Table caption="Leads" minWidth={760}>
          <thead>
            <tr>
              <Th>Lead</Th>
              <Th>Source</Th>
              <Th>Stage</Th>
              <Th align="end">Expected value</Th>
              <Th>Next follow-up</Th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id}>
                <Td>
                  <CellTitle
                    title={<Link href={`/leads/${l.id}`}>{l.title}</Link>}
                    meta={
                      <>
                        <span className="sr-only">Lead number: </span>
                        {l.number}
                      </>
                    }
                    note={`${l.companyName} · ${l.contactName}`}
                  />
                </Td>
                <Td>{sentence(l.source)}</Td>
                <Td nowrap>
                  <StageBadge kind="lead" stage={l.stage} />
                </Td>
                <Td align="end" nowrap>
                  {moneyOrNull(l.expectedValue, l.currency) ?? (
                    <span className={styles.quiet}>Not set</span>
                  )}
                </Td>
                <Td nowrap>
                  {l.nextFollowUpAt ? (
                    <time dateTime={l.nextFollowUpAt}>{when(l.nextFollowUpAt)}</time>
                  ) : (
                    <span className={styles.quiet}>None planned</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      {leads !== null && leads.length >= LIMIT ? (
        <p className={styles.quiet}>
          Showing the first {LIMIT} leads. Search or filter by stage to narrow the list.
        </p>
      ) : null}
    </Page>
  );
}
