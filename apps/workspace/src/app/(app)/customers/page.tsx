import {
  CUSTOMER_RELATIONSHIPS,
  countryName,
  formatPartyPhoneForPrint,
  pageWindow,
  type CustomerDto,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import {
  countCustomersByRelationship,
  listCustomerIndustries,
  listCustomers,
  type RelationshipCounts,
} from '@/components/p2/customers/api';
import { findDuplicates, type DuplicateReason } from '@/components/p2/customers/duplicates';
import { Avatar } from '@/components/ui/avatar';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { ResultCount } from '@/components/ui/filter-bar';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { RowMenu } from '@/components/ui/row-menu';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';
import { when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import { OwnerCell } from '../leads/lead-cells';

import { companyLogo } from './_lib/company-logo';
import { CustomerFilters, RELATIONSHIP_LABEL } from './customer-filters';
import styles from './customers.module.css';

export const metadata: Metadata = { title: 'Organizations · Business OS' };
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZES = [10, DEFAULT_PAGE_SIZE, 50, 100];
/** The URL is the state: repeated `relationship` and `industry`, `q`, `page` and `rows`. */
const LIST = {
  multi: { relationship: CUSTOMER_RELATIONSHIPS, industry: /^.{1,100}$/ },
  rows: { allowed: PAGE_SIZES, default: DEFAULT_PAGE_SIZE },
} as const;
const FILTER_LABELS = {
  relationship: {
    label: 'Relationship',
    format: (v: string) => RELATIONSHIP_LABEL[v as keyof typeof RELATIONSHIP_LABEL] ?? v,
  },
  industry: { label: 'Industry' },
};

const RELATIONSHIP: Record<
  CustomerDto['relationship'],
  { tone: 'neutral' | 'info' | 'success'; text: string }
> = {
  prospect: { tone: 'info', text: 'Prospect' },
  active: { tone: 'success', text: 'Active' },
  inactive: { tone: 'neutral', text: 'Inactive' },
};

const DUPLICATE_TEXT: Record<DuplicateReason, string> = {
  pan_vat: 'same PAN/VAT as another customer in this list',
  name: 'same name as another customer in this list',
};

function Row({
  customer: c,
  duplicate,
  mayWrite,
}: {
  customer: CustomerDto;
  duplicate: DuplicateReason[] | undefined;
  mayWrite: boolean;
}) {
  const relationship = RELATIONSHIP[c.relationship];
  const details = `/customers/${encodeURIComponent(c.id)}`;

  return (
    <tr>
      <Td>
        <div className={styles.identity}>
          <Avatar {...companyLogo(c)} />
          <div className={styles.identityText}>
            <Link href={details} className={styles.name}>
              {c.legalName}
            </Link>
            <span className={styles.number}>{c.number}</span>
            {/* Narrow screens hide the Phone column; the number sits under the name instead (R6A, D8). */}
            {c.primaryPhone != null ? (
              <span className={styles.phoneUnderName}>
                {formatPartyPhoneForPrint(c.primaryPhone.e164)}
              </span>
            ) : null}
            {duplicate !== undefined || c.mergedIntoId !== null ? (
              <div className={styles.flags}>
                {duplicate !== undefined ? (
                  <Badge tone="warning">
                    Possible duplicate
                    <span className="sr-only">
                      : {duplicate.map((r) => DUPLICATE_TEXT[r]).join(', ')}
                    </span>
                  </Badge>
                ) : null}
                {c.mergedIntoId !== null ? <Badge tone="neutral">Merged</Badge> : null}
              </div>
            ) : null}
          </div>
        </div>
      </Td>
      {/* FX9: city and country only; the full address and every phone are on the detail page. */}
      <Td>{`${c.address.city}, ${countryName(c.country)}`}</Td>
      {/* R6A (D8): the primary contact's primary number, as the list sends it. */}
      <Td nowrap className={styles.phoneColumn ?? ''}>
        {c.primaryPhone != null ? (
          formatPartyPhoneForPrint(c.primaryPhone.e164)
        ) : (
          <span className={styles.quiet}>Not set</span>
        )}
      </Td>
      <Td>{c.industry ?? <span className={styles.quiet}>Not set</span>}</Td>
      <Td nowrap>{c.panVatNo ?? <span className={styles.quiet}>Not set</span>}</Td>
      <Td nowrap>
        {/* U15a-Q3, D46: the owner's name as the list sends it; no directory lookup. */}
        <OwnerCell name={c.ownerName ?? null} seedId={c.ownerUserId} />
      </Td>
      <Td nowrap>
        <time dateTime={c.updatedAt}>{when(c.updatedAt, 'date')}</time>
      </Td>
      <Td nowrap>
        <Badge tone={relationship.tone}>{relationship.text}</Badge>
      </Td>
      {mayWrite ? (
        <Td align="end">
          {c.mergedIntoId === null ? (
            <RowMenu
              label={`Actions for ${c.legalName}`}
              items={[{ label: 'Edit', href: `${details}/edit` }]}
            />
          ) : null}
        </Td>
      ) : null}
    </tr>
  );
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const session = await requireStaffSession('/customers');
  const params = await searchParams;
  const state = readList(params, LIST);
  const { q, page, rows: pageSize } = state;
  const relationship = state.multi.relationship as CustomerDto['relationship'][];
  const industry = state.multi.industry;
  const at = (patch: Parameters<typeof hrefWith>[2]) => hrefWith('/customers', params, patch);

  let customers: CustomerDto[] | null = null;
  let total: number | null = null;
  let industries: string[] = [];
  let counts: RelationshipCounts | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const window = pageWindow(page, pageSize);
    const [result, known, byRelationship] = await Promise.all([
      listCustomers(session, {
        ...(q !== undefined ? { q } : {}),
        ...(relationship.length > 0 ? { relationship } : {}),
        ...(industry.length > 0 ? { industry } : {}),
        limit: window.limit,
        offset: window.offset,
      }),
      // The Industry options are a convenience; the list still works without them.
      listCustomerIndustries(session).catch(() => [] as string[]),
      // The cards are a convenience too: without the counts they are left out, not shown as zero.
      countCustomersByRelationship(session),
    ]);
    customers = result.items;
    total = result.total;
    industries = known;
    counts = byRelationship;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  const duplicates =
    customers !== null ? findDuplicates(customers) : new Map<string, DuplicateReason[]>();
  const hasNext =
    customers !== null &&
    (total !== null ? page * pageSize < total : customers.length === pageSize);
  const first = (page - 1) * pageSize + 1;
  // Page level: may this person add a customer at all (the live grant, not the role defaults).
  const mayWrite = hasGrant(await getGrants(session), 'customer.write');
  const addButton = mayWrite ? (
    <>
      <LinkButton href="/imports/customers" variant="secondary" size="large">
        Import from CSV
      </LinkButton>
      <LinkButton href="/customers/new" size="large">
        <span aria-hidden="true" className={styles.plus}>
          +
        </span>
        Add Organization
      </LinkButton>
    </>
  ) : null;
  const pages = [...(page > 1 ? [page - 1] : []), page, ...(hasNext ? [page + 1] : [])].map(
    (number) => ({ page: number, href: at({ page: number > 1 ? number : null }) }),
  );
  const filtersOn = activeFilterLabels(state, FILTER_LABELS, 'Search');
  const clearHref = clearFiltersHref('/customers', params, LIST);

  return (
    <Page>
      <PageHeader
        title="Organizations"
        description="Manage companies and customer relationships across legal entities."
        actions={addButton}
      />

      {counts !== null ? (
        <section className={styles.stats} aria-label="Organizations by relationship">
          <StatCard
            label="Organizations"
            value={counts.prospect + counts.active + counts.inactive}
            icon="building"
          />
          <StatCard label="Active" value={counts.active} icon="check-circle" tone="success" />
          <StatCard label="Prospects" value={counts.prospect} icon="target" />
          <StatCard label="Inactive" value={counts.inactive} icon="x-circle" tone="neutral" />
        </section>
      ) : null}

      <CustomerFilters
        relationship={relationship}
        industry={industry}
        industries={industries}
        rows={pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined}
      />
      {total !== null && customers !== null ? (
        <ResultCount shown={customers.length} total={total} noun="organization" />
      ) : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include organizations'
              : 'Organizations did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={at({ page: page > 1 ? page : null })}>Reload organizations</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Organizations are for the sales and finance teams. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : customers !== null && customers.length === 0 ? (
        filtersOn.length > 0 ? (
          <EmptyState
            title="No organizations match."
            icon="search"
            action={
              <LinkButton href={clearHref} variant="secondary">
                Clear filters
              </LinkButton>
            }
          >
            Hidden by {filtersOn.join('; ')}. Check the spelling, or search by the PAN/VAT number or
            the customer number instead.
          </EmptyState>
        ) : page > 1 ? (
          <EmptyState title="There are no more organizations.">
            <Link href={at({ page: null })}>Back to the first page</Link>
          </EmptyState>
        ) : (
          <EmptyState title="No organizations yet." icon="building" action={addButton}>
            Organizations appear here when a lead is converted or a company is added.
          </EmptyState>
        )
      ) : customers !== null ? (
        <>
          {duplicates.size > 0 ? (
            <Alert tone="warning" role="status" title="Some organizations may be the same company">
              Records marked Possible duplicate share a PAN/VAT number or a name with another record
              in this list. Check them before adding quotations to either.
            </Alert>
          ) : null}
          <div className={styles.directory}>
            <Table caption="Organizations" minWidth={1180} className={styles.table ?? ''}>
              <thead>
                <tr>
                  <Th className={styles.organizationColumn}>Organization</Th>
                  <Th>Location</Th>
                  <Th className={styles.phoneColumn ?? ''}>Phone</Th>
                  <Th>Industry</Th>
                  <Th>PAN/VAT</Th>
                  <Th>Owner</Th>
                  <Th>Updated</Th>
                  <Th>Relationship</Th>
                  {mayWrite ? (
                    <Th align="end">
                      <span className="sr-only">Actions</span>
                    </Th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <Row
                    key={c.id}
                    customer={c}
                    duplicate={duplicates.get(c.id)}
                    mayWrite={mayWrite}
                  />
                ))}
              </tbody>
            </Table>
            <div className={styles.tableFooter}>
              <Pagination
                label="Organization pages"
                summary={`Showing ${first}–${first + customers.length - 1}${total !== null ? ` of ${total}` : ''}`}
                currentPage={page}
                pages={pages}
                {...(page > 1
                  ? { previousHref: at({ page: page - 1 > 1 ? page - 1 : null }) }
                  : {})}
                {...(hasNext ? { nextHref: at({ page: page + 1 }) } : {})}
              />
              <nav aria-label="Rows per page" className={styles.rows}>
                <span aria-hidden="true">Rows</span>
                {PAGE_SIZES.map((size) => (
                  <LinkButton
                    key={size}
                    href={at({ rows: size === DEFAULT_PAGE_SIZE ? null : size })}
                    variant={size === pageSize ? 'secondary' : 'tertiary'}
                    size="small"
                    aria-current={size === pageSize ? 'true' : undefined}
                    aria-label={`${size} rows per page`}
                  >
                    {size}
                  </LinkButton>
                ))}
              </nav>
            </div>
          </div>
        </>
      ) : null}
    </Page>
  );
}
