import { LEAD_SOURCES, LEAD_STAGES, type LeadDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { Board } from '@/components/p2/crm/board';
import { listLeads } from '@/components/p2/crm/crm-api';
import { moneyOrNull, sentence } from '@/components/p2/crm/format';
import { LoadProblem, StageBadge, ViewSwitch } from '@/components/p2/crm/server-bits';
import { boardColumns, groupByStage, stageLabel, userMoves } from '@/components/p2/crm/stages';
import type { BoardColumnData } from '@/components/p2/crm/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';

import { moveLeadStageAction } from './actions';
import styles from './leads.module.css';
import { QualifyLead } from './qualify-lead';

export const metadata: Metadata = { title: 'Leads · Business OS' };
export const dynamic = 'force-dynamic';

const LIMIT = 200;
const PAGE_SIZES = [5, 10, 20];
type Param = 'view' | 'q' | 'stage' | 'source' | 'page' | 'rows';
type Search = Partial<Record<Param, string | string[]>>;
type Filters = Partial<Record<Param, string | undefined>>;

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;

function href(params: Filters): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return query.size > 0 ? `/leads?${query.toString()}` : '/leads';
}

function columnsFor(leads: LeadDto[], numberSystem: NumberSystem): BoardColumnData[] {
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
      value: moneyOrNull(lead.expectedValue, lead.currency, numberSystem),
      version: lead.version,
      moves: userMoves('lead', lead.stage),
    })),
  }));
}

const summaryStages = [
  { stage: 'new', icon: 'target', tone: 'neutral' },
  { stage: 'contacted', icon: 'user', tone: 'info' },
  { stage: 'qualified', icon: 'briefcase', tone: 'info' },
  { stage: 'converted', icon: 'check-circle', tone: 'success' },
] as const;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const session = await requireStaffSession('/leads');
  const numberSystem = await getNumberSystem();
  const sp = await searchParams;
  const view = one(sp.view) === 'board' ? 'board' : 'table';
  const q = one(sp.q)?.trim().slice(0, 100) || undefined;
  const stageParam = one(sp.stage);
  const stage =
    view === 'table' && (LEAD_STAGES as readonly string[]).includes(stageParam ?? '')
      ? stageParam
      : undefined;
  const sourceParam = one(sp.source);
  const source = (LEAD_SOURCES as readonly string[]).includes(sourceParam ?? '')
    ? sourceParam
    : undefined;
  const rowsParam = Number(one(sp.rows));
  const rows = PAGE_SIZES.includes(rowsParam) ? rowsParam : 5;
  const pageParam = Number(one(sp.page));
  const requestedPage = Number.isSafeInteger(pageParam) ? Math.max(1, pageParam) : 1;
  const filtered = Boolean(q || stage || source);
  const filters = { q, stage, source, rows: rows === 5 ? undefined : String(rows) };

  let leads: LeadDto[];
  try {
    leads = await listLeads(session, {
      ...(q ? { q } : {}),
      ...(stage ? { stage } : {}),
      limit: LIMIT,
    });
  } catch (err) {
    const problem = failureOf(err);
    return (
      <Page>
        <PageHeader title="Leads" actions={<LinkButton href="/leads/new">Add lead</LinkButton>} />
        <LoadProblem
          status={problem.status}
          message={problem.message}
          what="leads"
          reloadHref={href({
            ...filters,
            view: view === 'board' ? 'board' : undefined,
            page: one(sp.page),
          })}
        />
      </Page>
    );
  }

  // The API supports search and stage filters and returns a capped array. Source and pages
  // narrow that returned set, so the totals describe these results only.
  const matches = source ? leads.filter((lead) => lead.source === source) : leads;
  const hasMore = leads.length === LIMIT;
  const pageCount = Math.max(1, Math.ceil(matches.length / rows));
  const currentPage = Math.min(requestedPage, pageCount);
  const start = (currentPage - 1) * rows;
  const pageHref = (page: number) =>
    href({ ...filters, page: page === 1 ? undefined : String(page) });
  const pageLinks = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((page) => Math.abs(page - currentPage) <= 2)
    .map((page) => ({ page, href: pageHref(page) }));

  return (
    <Page>
      <PageHeader
        title="Leads"
        description="Track enquiries, follow up with contacts, and turn qualified leads into opportunities."
        actions={
          <LinkButton href="/leads/new" size="large">
            <span aria-hidden="true">+</span> Add lead
          </LinkButton>
        }
      />

      {!filtered && !hasMore ? (
        <section className={styles.stats} aria-label="Lead summary">
          <StatCard label="Total leads" value={leads.length} icon="users" />
          {summaryStages.map(({ stage, icon, tone }) => (
            <StatCard
              key={stage}
              label={stageLabel('lead', stage)}
              value={leads.filter((lead) => lead.stage === stage).length}
              icon={icon}
              tone={tone}
            />
          ))}
        </section>
      ) : null}

      <div className={styles.results}>
        <div className={styles.toolbar}>
          <form method="get" action="/leads" className={styles.filters} role="search">
            {view === 'board' ? <input type="hidden" name="view" value="board" /> : null}
            {rows !== 5 ? <input type="hidden" name="rows" value={rows} /> : null}
            <SearchInput
              key={q ?? ''}
              aria-label="Search leads"
              placeholder="Search leads"
              name="q"
              defaultValue={q ?? ''}
              maxLength={100}
              wrapperClassName={styles.search}
            />
            <div className={styles.filterControls}>
              <Select
                key={source ?? ''}
                aria-label="Lead source"
                name="source"
                defaultValue={source ?? ''}
                className={styles.filter}
              >
                <option value="">All sources</option>
                {LEAD_SOURCES.map((value) => (
                  <option key={value} value={value}>
                    {sentence(value)}
                  </option>
                ))}
              </Select>
              {view === 'table' ? (
                <Select
                  key={stage ?? ''}
                  aria-label="Lead status"
                  name="stage"
                  defaultValue={stage ?? ''}
                  className={styles.filter}
                >
                  <option value="">All statuses</option>
                  {LEAD_STAGES.map((value) => (
                    <option key={value} value={value}>
                      {stageLabel('lead', value)}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Button type="submit" variant="secondary">
                Apply
              </Button>
            </div>
          </form>
          <ViewSwitch
            current={view}
            hrefs={{
              table: href(filters),
              board: href({ ...filters, view: 'board', stage: undefined }),
            }}
          />
        </div>

        {matches.length === 0 ? (
          filtered ? (
            <EmptyState
              title="No leads match"
              action={
                <Link href={href({ view: view === 'board' ? 'board' : undefined })}>
                  Clear filters
                </Link>
              }
            >
              Try a different search or filter.
            </EmptyState>
          ) : (
            <EmptyState
              title="No leads yet"
              action={<LinkButton href="/leads/new">Add lead</LinkButton>}
            >
              Website enquiries appear here. Add a lead for a call or a walk-in.
            </EmptyState>
          )
        ) : view === 'board' ? (
          <Board
            columns={columnsFor(matches, numberSystem)}
            action={moveLeadStageAction}
            noun="lead"
          />
        ) : (
          <div className={styles.listCard}>
            <Table caption="Leads" minWidth={900} className={styles.table ?? ''}>
              <thead>
                <tr>
                  <Th>Lead name</Th>
                  <Th>Organization</Th>
                  <Th>Contact person</Th>
                  <Th>Source</Th>
                  <Th className={styles.followUpColumn}>Status</Th>
                  <Th className={styles.followUpColumn}>Next follow-up</Th>
                  <Th className={styles.followUpColumn}>Quick action</Th>
                </tr>
              </thead>
              <tbody>
                {matches.slice(start, start + rows).map((lead) => {
                  const leadHref = `/leads/${lead.id}`;
                  const value = moneyOrNull(lead.expectedValue, lead.currency, numberSystem);
                  const canQualify = userMoves('lead', lead.stage).some(
                    (move) => move.stage === 'qualified',
                  );
                  return (
                    <tr key={lead.id}>
                      <Td>
                        <div className={styles.leadName}>
                          <CellTitle title={<Link href={leadHref}>{lead.title}</Link>} />
                          <span className={styles.recordNumber}>{lead.number}</span>
                          {value && (
                            <span className={styles.quiet} title="Expected value">
                              {value}
                            </span>
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
                      <Td nowrap className={styles.followUpColumn}>
                        <StageBadge kind="lead" stage={lead.stage} />
                      </Td>
                      <Td nowrap className={styles.followUpColumn}>
                        {lead.nextFollowUpAt ? (
                          <time dateTime={lead.nextFollowUpAt}>
                            {when(lead.nextFollowUpAt, 'date')}
                          </time>
                        ) : (
                          <span className={styles.quiet}>None planned</span>
                        )}
                      </Td>
                      <Td nowrap className={styles.followUpColumn}>
                        {canQualify ? (
                          <QualifyLead
                            id={lead.id}
                            number={lead.number}
                            version={lead.version}
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
                summary={`Showing ${start + 1}–${Math.min(start + rows, matches.length)}${hasMore ? '' : ` of ${matches.length}`}`}
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
                    href={href({ ...filters, rows: size === 5 ? undefined : String(size) })}
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

        {hasMore ? (
          <p className={styles.quiet}>
            Results use the first {LIMIT} leads returned. Search or filter by stage to narrow the
            list.
          </p>
        ) : null}
      </div>
    </Page>
  );
}
