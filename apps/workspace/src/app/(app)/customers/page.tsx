import type { CustomerDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listCustomers } from '@/components/p2/customers/api';
import {
  findDuplicates,
  parsePage,
  type DuplicateReason,
} from '@/components/p2/customers/duplicates';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import styles from './customers.module.css';

export const metadata: Metadata = { title: 'Customers · Business OS' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
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

function href(q: string, page: number): string {
  const params = new URLSearchParams();
  if (q !== '') params.set('q', q);
  if (page > 1) params.set('page', String(page));
  const text = params.toString();
  return text === '' ? '/customers' : `/customers?${text}`;
}

function Row({ c, duplicate }: { c: CustomerDto; duplicate: DuplicateReason[] | undefined }) {
  const relationship = RELATIONSHIP[c.relationship];
  return (
    <tr>
      <Td>
        <CellTitle
          title={<span className={styles.name}>{c.legalName}</span>}
          meta={
            <>
              <span className="sr-only">Customer number: </span>
              {c.number}
            </>
          }
          note={
            duplicate !== undefined || c.mergedIntoId !== null ? (
              <span className={styles.flags}>
                {duplicate !== undefined ? (
                  <Badge tone="warning">
                    Possible duplicate
                    <span className="sr-only">
                      : {duplicate.map((r) => DUPLICATE_TEXT[r]).join(', ')}
                    </span>
                  </Badge>
                ) : null}
                {c.mergedIntoId !== null ? (
                  <Badge tone="neutral">Merged into another record</Badge>
                ) : null}
              </span>
            ) : null
          }
        />
      </Td>
      <Td>{c.industry ?? <span className={styles.quiet}>Not set</span>}</Td>
      <Td nowrap>{c.panVatNo ?? <span className={styles.quiet}>Not set</span>}</Td>
      <Td nowrap>
        <Badge tone={relationship.tone}>{relationship.text}</Badge>
      </Td>
      <Td nowrap>
        <time dateTime={c.updatedAt}>{when(c.updatedAt, 'date')}</time>
      </Td>
    </tr>
  );
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}) {
  const session = await requireStaffSession('/customers');
  const params = await searchParams;
  const q = (typeof params.q === 'string' ? params.q.trim() : '').slice(0, MAX_QUERY);
  const page = parsePage(params.page);

  let customers: CustomerDto[] | null = null;
  let total: number | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const result = await listCustomers(session, {
      q,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
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
    (total !== null ? page * PAGE_SIZE < total : customers.length === PAGE_SIZE);
  const first = (page - 1) * PAGE_SIZE + 1;

  return (
    <Page>
      <PageHeader
        title="Customers"
        description="Companies you sell to. Each customer is shared by every legal entity; payment terms are set per entity."
        actions={
          total !== null || (customers !== null && customers.length > 0) ? (
            <Badge tone="info" role="status" className={styles.count}>
              {total ?? customers?.length ?? 0}{' '}
              {(total ?? customers?.length) === 1 ? 'customer' : 'customers'}
            </Badge>
          ) : null
        }
      />

      <form method="get" action="/customers" role="search" className={styles.search}>
        <Field label="Search customers" hint="By name, customer number or PAN/VAT.">
          {(control) => (
            <Input
              type="search"
              name="q"
              defaultValue={q}
              maxLength={MAX_QUERY}
              autoComplete="off"
              {...control}
            />
          )}
        </Field>
        <div className={styles.searchActions}>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {q !== '' ? (
            <LinkButton href="/customers" variant="ghost">
              Clear search
            </LinkButton>
          ) : null}
        </div>
      </form>

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include customers'
              : 'Customers did not load'
          }
          actions={
            problem.status !== 403 ? <Link href={href(q, page)}>Reload customers</Link> : null
          }
        >
          {problem.status === 403
            ? 'Customers are for the sales and finance teams. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : customers !== null && customers.length === 0 ? (
        q !== '' ? (
          <EmptyState title={`No customers match "${q}".`} icon="search">
            Check the spelling, or search by the PAN/VAT number or the customer number instead.
          </EmptyState>
        ) : page > 1 ? (
          <EmptyState title="There are no more customers.">
            <Link href={href(q, 1)}>Back to the first page</Link>
          </EmptyState>
        ) : (
          <EmptyState title="No customers yet." icon="building">
            Customers appear here when a lead is converted or a customer is added.
          </EmptyState>
        )
      ) : customers !== null ? (
        <>
          {duplicates.size > 0 ? (
            <Alert tone="warning" role="status" title="Some customers may be the same company">
              Records marked Possible duplicate share a PAN/VAT number or a name with another record
              in this list. Check them before adding quotations to either.
            </Alert>
          ) : null}
          <Table caption="Customers" minWidth={720}>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Industry</Th>
                <Th>PAN/VAT</Th>
                <Th>Relationship</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <Row key={c.id} c={c} duplicate={duplicates.get(c.id)} />
              ))}
            </tbody>
          </Table>
          <nav aria-label="Pages" className={styles.pager}>
            <span className={styles.note}>
              Showing {first} to {first + customers.length - 1}
              {total !== null ? ` of ${total}` : ''}
            </span>
            <span className={styles.pagerLinks}>
              {page > 1 ? (
                <LinkButton href={href(q, page - 1)} variant="secondary" size="small">
                  Previous
                </LinkButton>
              ) : null}
              {hasNext ? (
                <LinkButton href={href(q, page + 1)} variant="secondary" size="small">
                  Next
                </LinkButton>
              ) : null}
            </span>
          </nav>
        </>
      ) : null}
    </Page>
  );
}
