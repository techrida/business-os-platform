import type { InvoiceListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { listInvoices, type InvoiceFilter } from '@/lib/api-billing';
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

function InvoiceRow({ item }: { item: InvoiceListItem }) {
  // A draft has no number yet: the link names what it is, so it is never an empty or "null" link.
  const name =
    item.number ?? `${kindMeta(item.kind).label} (${statusMeta(item.status).label.toLowerCase()})`;
  return (
    <tr>
      <Td nowrap>
        <Link href={`/invoices/${encodeURIComponent(item.id)}`} className={styles.number}>
          {name}
        </Link>
      </Td>
      <Td nowrap>{kindMeta(item.kind).label}</Td>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <InvoiceStatusBadge status={item.status} />
      </Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.total, item.currency)}</span>
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
          <span className={styles.quiet}>None</span>
        )}
      </Td>
    </tr>
  );
}

export default async function InvoicesPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ kind?: string | string[]; status?: string | string[] }>;
}) {
  const raw = await searchParams;
  const kind = parseKindFilter(raw.kind);
  const status = parseStatusFilter(raw.status);
  const filter: InvoiceFilter = {
    ...(kind !== undefined ? { kind } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  const query = new URLSearchParams();
  if (kind !== undefined) query.set('kind', kind);
  if (status !== undefined) query.set('status', status);
  const here = query.size > 0 ? `/invoices?${query.toString()}` : '/invoices';
  const filtered = kind !== undefined || status !== undefined;
  const session = await requireStaffSession(here);

  let items: InvoiceListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listInvoices(session, filter);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  return (
    <Page>
      <PageHeader
        title="Invoices"
        description="Every tax invoice, proforma, credit note and debit note with its customer, status and total."
        actions={
          <>
            {items !== null && items.length > 0 ? (
              <Badge tone="info" role="status" className={styles.count}>
                {items.length} {items.length === 1 ? 'invoice' : 'invoices'}
              </Badge>
            ) : null}
            {hasPermission(session.roles, 'invoice.draft') ? (
              <LinkButton href="/invoices/new">New invoice</LinkButton>
            ) : null}
          </>
        }
      />

      <form method="get" action="/invoices" className={styles.toolbar}>
        <div className={styles.filterField}>
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
        </div>
        <div className={styles.filterField}>
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
        </div>
        <div className={styles.toolbarActions}>
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
          {filtered ? <Link href="/invoices">Show all invoices</Link> : null}
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
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState icon="file-text" title="No invoices match these filters.">
            Choose other filters, or show all invoices.
          </EmptyState>
        ) : (
          <EmptyState icon="file-text" title="No invoices yet.">
            An invoice is drafted from a sales order&apos;s billing schedule. It appears here once
            it is saved.
          </EmptyState>
        )
      ) : items !== null ? (
        <Table caption="Invoices" minWidth={900}>
          <thead>
            <tr>
              <Th>Invoice</Th>
              <Th>Kind</Th>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th align="end">Total</Th>
              <Th>Issued</Th>
              <Th>Due</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <InvoiceRow key={item.id} item={item} />
            ))}
          </tbody>
        </Table>
      ) : null}
    </Page>
  );
}
