import type { InvoiceListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { listInvoices, type InvoiceFilter } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import { InvoiceStatusBadge } from './_components/badges';
import styles from './_components/invoice.module.css';
import {
  KIND_FILTER_OPTIONS,
  kindMeta,
  parseKindFilter,
  parseStatusFilter,
  STATUS_FILTER_OPTIONS,
  statusMeta,
} from './_lib/meta';

export const metadata: Metadata = { title: 'Invoices · Business OS' };
export const dynamic = 'force-dynamic';

const CUSTOMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIZES = [5, 10, 25] as const;
const stringParam = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : '';

function InvoiceRow({ item }: { item: InvoiceListItem }) {
  const kind = kindMeta(item.kind).label;
  const name = item.number ?? `${kind} (${statusMeta(item.status).label.toLowerCase()})`;
  const href = `/invoices/${encodeURIComponent(item.id)}`;
  return (
    <tr>
      <Th scope="row">
        <Link href={href} className={styles.number}>
          {name}
        </Link>
      </Th>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <Badge tone="neutral">{kind}</Badge>
      </Td>
      <Td nowrap>
        {item.issueDate !== null ? (
          <time dateTime={item.issueDate}>{when(item.issueDate, 'date')}</time>
        ) : (
          <span className={styles.quiet}>Not issued</span>
        )}
      </Td>
      <Td nowrap>
        {item.dueDate !== null ? (
          <time dateTime={item.dueDate}>{when(item.dueDate, 'date')}</time>
        ) : (
          <span className={styles.quiet}>—</span>
        )}
      </Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.total, item.currency)}</span>
      </Td>
      <Td nowrap>
        <InvoiceStatusBadge status={item.status} />
      </Td>
      <Td nowrap>
        <Link href={href} className={styles.rowAction} aria-label={`View ${name}`}>
          <Icon name="chevron-right" size={20} />
        </Link>
      </Td>
    </tr>
  );
}

function InvoiceStats({ invoices }: { invoices: readonly InvoiceListItem[] }) {
  return (
    <section aria-label="Invoice summary" className={styles.stats}>
      <StatCard label="Total invoices" value={invoices.length} icon="receipt" />
      <StatCard
        label="Drafts"
        value={invoices.filter((item) => item.status === 'draft').length}
        icon="file-text"
        tone="neutral"
      />
      <StatCard
        label="Pending approval"
        value={invoices.filter((item) => item.status === 'submitted').length}
        icon="inbox"
        tone="warning"
      />
      <StatCard
        label="Issued"
        value={invoices.filter((item) => item.status === 'issued').length}
        icon="check-circle"
        tone="success"
      />
    </section>
  );
}

type SearchParams = Record<
  'kind' | 'status' | 'customerId' | 'q' | 'page' | 'rows',
  string | string[] | undefined
>;

function invoiceUrl(params: URLSearchParams) {
  return params.size > 0 ? `/invoices?${params}` : '/invoices';
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Partial<SearchParams>>;
}) {
  const raw = await searchParams;
  const kind = parseKindFilter(raw.kind);
  const status = parseStatusFilter(raw.status);
  const candidate = stringParam(raw.customerId);
  const customerId = CUSTOMER_ID.test(candidate) ? candidate : '';
  const q = stringParam(raw.q).trim().slice(0, 100);
  const rows = SIZES.find((size) => size.toString() === raw.rows) ?? SIZES[0];
  const pageParam = stringParam(raw.page);
  const requestedPage = /^\d{1,9}$/.test(pageParam) ? Math.max(1, Number(pageParam)) : 1;
  const filter: InvoiceFilter = {
    ...(kind !== undefined ? { kind } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(customerId ? { customerId } : {}),
  };
  const filters = new URLSearchParams();
  if (kind !== undefined) filters.set('kind', kind);
  if (status !== undefined) filters.set('status', status);
  if (customerId) filters.set('customerId', customerId);
  if (q) filters.set('q', q);
  const hereQuery = new URLSearchParams(filters);
  if (rows !== SIZES[0]) hereQuery.set('rows', rows.toString());
  if (requestedPage > 1) hereQuery.set('page', requestedPage.toString());
  const here = invoiceUrl(hereQuery);
  const session = await requireStaffSession(here);

  let items: InvoiceListItem[] | null = null;
  let summary: InvoiceListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const result = listInvoices(session, filter);
    // Use the same scope as the table for summary counts and the customer choices.
    const all = Object.keys(filter).length ? listInvoices(session).catch(() => null) : result;
    [items, summary] = await Promise.all([result, all]);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const names = new Map(
    (summary ?? items ?? []).map((item) => [item.customerId, item.customerName]),
  );
  const customers = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const needle = q.toLocaleLowerCase();
  const matches =
    items?.filter(
      (item) =>
        !needle ||
        item.customerName.toLocaleLowerCase().includes(needle) ||
        item.number?.toLocaleLowerCase().includes(needle),
    ) ?? [];
  const pageCount = Math.max(1, Math.ceil(matches.length / rows));
  const page = Math.min(requestedPage, pageCount);
  const first = (page - 1) * rows;
  const pageHref = (number: number) => {
    const params = new URLSearchParams(filters);
    if (rows !== SIZES[0]) params.set('rows', rows.toString());
    if (number > 1) params.set('page', number.toString());
    return invoiceUrl(params);
  };
  const pages = Array.from({ length: Math.min(3, pageCount) }, (_, index) => {
    const number = Math.max(1, Math.min(page - 1, pageCount - 2)) + index;
    return { page: number, href: pageHref(number) };
  });

  return (
    <Page>
      <PageHeader
        title="Invoices"
        description="Bill customers against sales orders or directly, then track payments."
        actions={
          hasPermission(session.roles, 'invoice.draft') ? (
            <LinkButton href="/invoices/new" size="large">
              <span aria-hidden="true" className={styles.addIcon}>
                +
              </span>
              Create Invoice
            </LinkButton>
          ) : null
        }
      />

      {summary !== null ? <InvoiceStats invoices={summary} /> : null}

      <form method="get" action="/invoices" className={styles.toolbar}>
        {rows !== SIZES[0] ? <input type="hidden" name="rows" value={rows} /> : null}
        <SearchInput
          name="q"
          aria-label="Search invoices"
          placeholder="Search invoices"
          defaultValue={q}
          maxLength={100}
          wrapperClassName={styles.search}
        />
        <div className={styles.filterFields}>
          <Field label="Customer">
            {(control) => (
              <Select name="customerId" defaultValue={customerId} {...control}>
                <option value="">All customers</option>
                {customerId && !names.has(customerId) ? (
                  <option value={customerId}>Selected customer</option>
                ) : null}
                {customers.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Kind">
            {(control) => (
              <Select name="kind" defaultValue={kind ?? ''} {...control}>
                <option value="">All kinds</option>
                {KIND_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Status">
            {(control) => (
              <Select name="status" defaultValue={status ?? ''} {...control}>
                <option value="">All statuses</option>
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
          {filters.size ? <Link href="/invoices">Show all invoices</Link> : null}
        </div>
      </form>

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include invoices'
              : 'The invoices did not load'
          }
          actions={problem.status !== 403 ? <Link href={here}>Reload the invoices</Link> : null}
        >
          {problem.status === 403
            ? 'Invoices are for the accounts and finance teams and for management. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : matches.length === 0 ? (
        filters.size ? (
          <EmptyState icon="file-text" title="No invoices match these filters.">
            Choose other filters, or show all invoices.
          </EmptyState>
        ) : (
          <EmptyState icon="file-text" title="No invoices yet.">
            Draft an invoice here or from a sales order’s billing schedule.
          </EmptyState>
        )
      ) : (
        <div className={styles.tableCard}>
          <Table caption="Invoices" minWidth={920} className={styles.listTable ?? ''}>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Kind</Th>
                <Th>Issued on</Th>
                <Th>Due</Th>
                <Th align="end">Total</Th>
                <Th>Status</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {matches.slice(first, first + rows).map((item) => (
                <InvoiceRow key={item.id} item={item} />
              ))}
            </tbody>
          </Table>
          <div className={styles.tableFooter}>
            <Pagination
              label="Invoice pages"
              summary={`Showing ${first + 1}–${Math.min(first + rows, matches.length)} of ${matches.length}`}
              {...(page > 1 ? { previousHref: pageHref(page - 1) } : {})}
              {...(page < pageCount ? { nextHref: pageHref(page + 1) } : {})}
              currentPage={page}
              pages={pages}
            />
            <form action="/invoices" className={styles.rowsForm}>
              {[...filters].map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <label>
                Rows
                <Select name="rows" defaultValue={rows}>
                  {SIZES.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" size="small" variant="tertiary">
                Apply
              </Button>
            </form>
          </div>
        </div>
      )}
    </Page>
  );
}
