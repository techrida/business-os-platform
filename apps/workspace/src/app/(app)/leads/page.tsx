import { LEAD_SOURCES, LEAD_STAGES, type LeadDto, pageWindow } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { Board } from '@/components/p2/crm/board';
import { listLeadOwners, ownerFilterNames } from '@/components/p2/crm/crm-api';
import {
  getLeadSummary,
  type LeadSummary,
  type LeadsPage,
  listLeadsPage,
} from '@/components/p2/crm/leads-api';
import { moneyOrNull, sentence } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge, ViewSwitch } from '@/components/p2/crm/server-bits';
import {
  boardColumns,
  boardMoves,
  groupByStage,
  resolvedMoves,
  stageLabel,
} from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { getPermissionCheck } from '@/lib/live-permissions';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import { moveLeadStageAction } from './actions';
import { NextFollowUpCell, OwnerCell } from './lead-cells';
import { LeadFilters } from './lead-filters';
import styles from './leads.module.css';
import { QualifyLead } from './qualify-lead';
import { Tooltip } from '@/components/ui/tooltip';

export const metadata: Metadata = { title: 'Leads · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/leads';
const BOARD_LIMIT = 200;
const PAGE_SIZES = [5, 10, 20] as const;
const ROWS = { allowed: PAGE_SIZES, default: 5 };

const stageOptions = LEAD_STAGES.map((value) => ({ value, label: stageLabel('lead', value) }));
const sourceOptions = LEAD_SOURCES.map((value) => ({ value, label: sentence(value) }));

function columnsFor(leads: LeadDto[], numberSystems: NumberSystems): BoardColumnData[] {
  const groups = groupByStage('lead', leads);
  return boardColumns('lead').map((column) => ({
    stage: column.stage,
    label: column.label,
    note: column.note,
    cards: (groups.get(column.stage) ?? []).map((lead) => ({
      id: lead.id,
      href: `/leads/${lead.id}`,
      title: lead.title,
      number: lead.number,
      subtitle: `${lead.companyName} · ${lead.contactName}`,
      value: moneyOrNull(lead.expectedValue, lead.currency, numberSystems),
      version: lead.version,
      moves: boardMoves('lead', lead),
    })),
  }));
}

const summaryStages = [
  { stage: 'new', icon: 'target', tone: 'neutral' },
  { stage: 'contacted', icon: 'user', tone: 'info' },
  { stage: 'qualified', icon: 'briefcase', tone: 'info' },
  { stage: 'converted', icon: 'check-circle', tone: 'success' },
] as const;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await requireStaffSession(PATH);
  const numberSystems = await getNumberSystems();
  // Add lead only for people who may create one (TR-Q3); the API still checks crm.lead.write.
  const canCreate = (await getPermissionCheck(session))('crm.lead.write');
  const sp = await searchParams;
  const names = await ownerFilterNames(session, 'leads');
  const ownerOptions = [...names]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const view = readList(sp, { search: false, single: { view: ['table', 'board'] } }).single.view;
  const board = view === 'board';
  // Without the user directory there is no owner control, so an owner param is not applied either.
  const spec = {
    multi: { stage: LEAD_STAGES, source: LEAD_SOURCES, ownerUserId: [...names.keys()] },
    rows: ROWS,
  } as const;
  const state = readList(sp, spec);
  // The board's columns are the stages, so it has no stage filter.
  const stages = board ? [] : state.multi.stage;
  const sources = state.multi.source;
  const owners = state.multi.ownerUserId;
  const { q, rows } = state;
  const filtered = q !== undefined || stages.length > 0 || sources.length > 0 || owners.length > 0;
  const shared = { ...(q !== undefined ? { q } : {}), source: sources, ownerUserId: owners };

  let pageInfo = pageWindow(board ? 1 : state.page, board ? BOARD_LIMIT : rows);
  let result: LeadsPage;
  let summary: LeadSummary | null;
  try {
    const [first, counts] = await Promise.all([
      listLeadsPage(session, {
        ...shared,
        stage: stages,
        limit: pageInfo.limit,
        offset: pageInfo.offset,
      }),
      // Cards are a courtesy: if they fail the list still renders. The summary refuses `stage`.
      getLeadSummary(session, shared).catch(() => null),
    ]);
    summary = counts;
    result = first;
    pageInfo = pageWindow(pageInfo.page, pageInfo.limit, first.total);
    if (first.items.length === 0 && first.total > 0) {
      // The URL named a page past the end: show the last one instead of an empty table.
      result = await listLeadsPage(session, {
        ...shared,
        stage: stages,
        limit: pageInfo.limit,
        offset: pageInfo.offset,
      });
    }
  } catch (err) {
    const problem = failureOf(err);
    return (
      <Page>
        <PageHeader
          title="Leads"
          actions={canCreate ? <LinkButton href="/leads/new">Add lead</LinkButton> : undefined}
        />
        <LoadProblem
          status={problem.status}
          message={problem.message}
          what="leads"
          reloadHref={hrefWith(PATH, sp, { page: state.page > 1 ? state.page : null })}
        />
      </Page>
    );
  }

  const matches = result.items;
  const total = result.total;
  const pageCount = pageInfo.pageCount;
  const currentPage = pageInfo.page;
  const pageHref = (page: number) => hrefWith(PATH, sp, { page: page > 1 ? page : null });

  // Owner pictures from the people the caller may assign to; a failure only leaves initials.
  const ownerPictures = new Map<string, string>();
  try {
    for (const o of await listLeadOwners(session)) {
      if (o.avatarDocumentId) ownerPictures.set(o.userId, o.avatarDocumentId);
    }
  } catch {
    // Initials stay.
  }

  const now = new Date();
  const pageLinks = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((page) => Math.abs(page - currentPage) <= 2)
    .map((page) => ({ page, href: pageHref(page) }));
  const hiding = activeFilterLabels(
    { q, multi: { stage: stages, source: sources, ownerUserId: owners }, single: {} },
    {
      stage: { label: 'Status', format: (v) => stageLabel('lead', v) },
      source: { label: 'Source', format: sentence },
      ownerUserId: { label: 'Owner', format: (v) => names.get(v) ?? 'Owner name unavailable' },
    },
  );

  return (
    <Page>
      <PageHeader
        title="Leads"
        description="Track enquiries, follow up with contacts, and turn qualified leads into opportunities."
        actions={
          canCreate ? (
            <LinkButton href="/leads/new" size="large">
              <span aria-hidden="true">+</span> Add lead
            </LinkButton>
          ) : undefined
        }
      />

      {summary !== null ? (
        <section className={styles.stats} aria-label="Lead summary">
          <StatCard label="Total leads" value={summary.total} icon="users" />
          {summaryStages.map(({ stage, icon, tone }) => (
            <StatCard
              key={stage}
              label={stageLabel('lead', stage)}
              value={summary.byStage[stage]}
              icon={icon}
              tone={tone}
            />
          ))}
        </section>
      ) : null}

      <div className={styles.results}>
        <div className={styles.toolbar}>
          <LeadFilters
            view={board ? 'board' : 'table'}
            rows={rows}
            stages={stages}
            sources={sources}
            owners={owners}
            stageOptions={stageOptions}
            sourceOptions={sourceOptions}
            ownerOptions={ownerOptions}
          />
          <ViewSwitch
            current={board ? 'board' : 'table'}
            hrefs={{
              table: hrefWith(PATH, sp, { view: null }),
              board: hrefWith(PATH, sp, { view: 'board', stage: null }),
            }}
          />
          <ResultCount shown={matches.length} total={total} noun="lead" />
        </div>

        {total === 0 ? (
          filtered ? (
            <EmptyState
              title="No leads match"
              action={<Link href={clearFiltersHref(PATH, sp, spec)}>Clear filters</Link>}
            >
              Nothing matches {hiding.join(', ')}.
            </EmptyState>
          ) : (
            <EmptyState
              title="No leads yet"
              action={canCreate ? <LinkButton href="/leads/new">Add lead</LinkButton> : undefined}
            >
              {canCreate
                ? 'Website enquiries appear here. Add a lead for a call or a walk-in.'
                : 'Website enquiries appear here.'}
            </EmptyState>
          )
        ) : board ? (
          <Board
            columns={columnsFor(matches, numberSystems)}
            action={moveLeadStageAction}
            noun="lead"
          />
        ) : (
          <div className={styles.listCard}>
            <Table caption="Leads" minWidth={1080} className={styles.table ?? ''}>
              <thead>
                <tr>
                  <Th>Lead name</Th>
                  <Th>Organization</Th>
                  <Th>Contact person</Th>
                  <Th>Source</Th>
                  <Th>Owner</Th>
                  <Th className={styles.followUpColumn}>Status</Th>
                  <Th className={styles.followUpColumn}>Next follow-up</Th>
                  <Th className={styles.followUpColumn}>Quick action</Th>
                </tr>
              </thead>
              <tbody>
                {matches.map((lead) => {
                  const leadHref = `/leads/${lead.id}`;
                  const value = moneyOrNull(lead.expectedValue, lead.currency, numberSystems);
                  const canQualify = resolvedMoves(
                    'lead',
                    lead.stage,
                    lead.allowedMoves,
                    lead.heldFromStage,
                  ).some((move) => move.stage === 'qualified');
                  return (
                    <tr key={lead.id}>
                      <Td>
                        <div className={styles.leadName}>
                          <CellTitle title={<Link href={leadHref}>{lead.title}</Link>} />
                          <span className={styles.recordNumber}>{lead.number}</span>
                          {value && (
                            <Tooltip content="Expected value">
                              <span className={styles.quiet}>{value}</span>
                            </Tooltip>
                          )}
                        </div>
                      </Td>
                      <Td>{lead.companyName}</Td>
                      <Td>
                        <div className={styles.contact}>
                          <Avatar name={lead.contactName} shape="circle" aria-hidden="true" />
                          <span>{lead.contactName}</span>
                        </div>
                      </Td>
                      <Td>
                        <Badge tone="neutral">{sentence(lead.source)}</Badge>
                      </Td>
                      <Td>
                        <OwnerCell
                          name={lead.ownerName}
                          seedId={lead.ownerUserId}
                          imageDocumentId={
                            lead.ownerUserId ? (ownerPictures.get(lead.ownerUserId) ?? null) : null
                          }
                        />
                      </Td>
                      <Td nowrap className={styles.followUpColumn}>
                        <StageBadge kind="lead" stage={lead.stage} />
                      </Td>
                      <Td nowrap className={styles.followUpColumn}>
                        <NextFollowUpCell at={lead.nextFollowUpAt} now={now} />
                      </Td>
                      <Td nowrap className={styles.followUpColumn}>
                        {canQualify ? (
                          <QualifyLead
                            id={lead.id}
                            number={lead.number}
                            version={lead.version}
                            variant="secondary"
                            size="small"
                          />
                        ) : (
                          <LinkButton
                            href={
                              lead.stage === 'qualified' ? `${leadHref}#lead-conversion` : leadHref
                            }
                            size="small"
                            variant="secondary"
                          >
                            {lead.stage === 'qualified' ? 'Convert lead' : 'View lead'}
                            <span className="sr-only"> {lead.number}</span>
                            <Icon name="chevron-right" size={16} />
                          </LinkButton>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <div className={styles.listFooter}>
              <Pagination
                label="Lead pages"
                summary={`Showing ${pageInfo.first}–${pageInfo.last} of ${total}`}
                currentPage={currentPage}
                pages={pageLinks}
                {...(currentPage > 1 ? { previousHref: pageHref(currentPage - 1) } : {})}
                {...(currentPage < pageCount ? { nextHref: pageHref(currentPage + 1) } : {})}
              />
              <nav className={styles.pageSize} aria-label="Rows per page">
                <span>Rows</span>
                {PAGE_SIZES.map((size) => (
                  <Link
                    key={size}
                    href={hrefWith(PATH, sp, { rows: size === 5 ? null : size })}
                    aria-label={`${size} rows per page`}
                    aria-current={rows === size ? 'true' : undefined}
                  >
                    {size}
                  </Link>
                ))}
              </nav>
            </div>
          </div>
        )}

        {board && total > BOARD_LIMIT ? (
          <p className={styles.quiet}>
            Showing the first {BOARD_LIMIT} of {total} leads. Search or filter to narrow the board.
          </p>
        ) : null}
      </div>
    </Page>
  );
}
