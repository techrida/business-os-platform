import type { CustomerDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listCustomers } from '@/components/p2/customers/api';
import {
  findDuplicates,
  parsePage,
  type DuplicateReason,
} from '@/components/p2/customers/duplicates';
import { Avatar } from '@/components/ui/avatar';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';
import { when } from '@/lib/kernel-format';

import styles from './customers.module.css';

export const metadata: Metadata = { title: 'Organizations · Business OS' };
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZES = [5, 10, DEFAULT_PAGE_SIZE, 50];
/** The longest search the page forwards: a longer one is cut, never sent whole to the API. */
const MAX_QUERY = 100;

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

function href(q: string, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (q !== '') params.set('q', q);
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set('rows', String(pageSize));
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text === '' ? '/customers' : `/customers?${text}`;
}

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
          <Avatar name={c.legalName} shape="circle" />
          <div className={styles.identityText}>
            <Link href={details} className={styles.name}>
              {c.legalName}
            </Link>
            <span className={styles.number}>{c.number}</span>
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
      <Td>{c.industry ?? <span className={styles.quiet}>Not set</span>}</Td>
      <Td nowrap>{c.panVatNo ?? <span className={styles.quiet}>Not set</span>}</Td>
      <Td nowrap>
        <time dateTime={c.updatedAt}>{when(c.updatedAt, 'date')}</time>
      </Td>
      <Td nowrap>
        <Badge tone={relationship.tone}>{relationship.text}</Badge>
      </Td>
      {mayWrite ? (
        <Td align="end">
          {c.mergedIntoId === null ? (
            <LinkButton
              href={`${details}/edit`}
              variant="tertiary"
              size="small"
              aria-label={`Edit ${c.legalName}`}
            >
              Edit
            </LinkButton>
          ) : null}
        </Td>
      ) : null}
    </tr>
  );
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string | string[];
    page?: string | string[];
    rows?: string | string[];
  }>;
}) {
  const session = await requireStaffSession('/customers');
  const params = await searchParams;
  const q = (typeof params.q === 'string' ? params.q.trim() : '').slice(0, MAX_QUERY);
  const page = parsePage(params.page);
  const pageSize = PAGE_SIZES.find((size) => String(size) === params.rows) ?? DEFAULT_PAGE_SIZE;

  let customers: CustomerDto[] | null = null;
  let total: number | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const result = await listCustomers(session, {
      q,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    customers = result.items;
    total = result.total;
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
    <LinkButton href="/customers/new" size="large">
      <span aria-hidden="true" className={styles.plus}>
        +
      </span>
      Add Organization
    </LinkButton>
  ) : null;
  const pages = [...(page > 1 ? [page - 1] : []), page, ...(hasNext ? [page + 1] : [])].map(
    (number) => ({ page: number, href: href(q, number, pageSize) }),
  );

  return (
    <Page>
      <PageHeader
        title="Organizations"
        description="Manage companies and customer relationships across legal entities."
        actions={addButton}
      />

      {total !== null ? (
        <div className={styles.stats}>
          <StatCard
            label={q ? 'Matching organizations' : 'Organizations'}
            value={total}
            icon="building"
          />
        </div>
      ) : null}

      <form method="get" action="/customers" role="search" className={styles.search}>
        {pageSize !== DEFAULT_PAGE_SIZE ? (
          <input type="hidden" name="rows" value={pageSize} />
        ) : null}
        <SearchInput
          aria-label="Search organizations"
          title="Search by name, customer number or PAN/VAT"
          placeholder="Search organizations"
          wrapperClassName={styles.searchField}
          name="q"
          defaultValue={q}
          maxLength={MAX_QUERY}
          autoComplete="off"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {q !== '' ? (
          <LinkButton href={href('', 1, pageSize)} variant="ghost">
            Clear search
          </LinkButton>
        ) : null}
      </form>

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
              <Link href={href(q, page, pageSize)}>Reload organizations</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Organizations are for the sales and finance teams. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : customers !== null && customers.length === 0 ? (
        q !== '' ? (
          <EmptyState title={`No organizations match "${q}".`} icon="search">
            Check the spelling, or search by the PAN/VAT number or the customer number instead.
          </EmptyState>
        ) : page > 1 ? (
          <EmptyState title="There are no more organizations.">
            <Link href={href(q, 1, pageSize)}>Back to the first page</Link>
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
            <Table caption="Organizations" minWidth={740} className={styles.table ?? ''}>
              <thead>
                <tr>
                  <Th className={styles.organizationColumn}>Organization</Th>
                  <Th>Industry</Th>
                  <Th>PAN/VAT</Th>
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
                {...(page > 1 ? { previousHref: href(q, page - 1, pageSize) } : {})}
                {...(hasNext ? { nextHref: href(q, page + 1, pageSize) } : {})}
              />
              <nav aria-label="Rows per page" className={styles.rows}>
                <span aria-hidden="true">Rows</span>
                {PAGE_SIZES.map((size) => (
                  <LinkButton
                    key={size}
                    href={href(q, 1, size)}
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
