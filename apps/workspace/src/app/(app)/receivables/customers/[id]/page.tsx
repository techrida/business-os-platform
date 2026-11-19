import type { CustomerAdvance, InvoiceSettlement } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { getCustomer } from '@/components/p2/customers/api';
import { isGuid } from '@/components/p2/customers/format';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { getCustomerAdvance, getCustomerStatement } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

import { isZeroAmount } from '../../_lib/aging';
import { settlementMeta } from '../../_lib/settlement';
import styles from '../../receivables.module.css';

export const metadata: Metadata = { title: 'Customer statement · Business OS' };
export const dynamic = 'force-dynamic';

const AGING = '/receivables/aging';

function Problem({
  title,
  message,
  tone = 'error',
  reloadHref,
}: {
  title: string;
  message: string;
  tone?: 'error' | 'info';
  reloadHref?: string;
}) {
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Receivables', href: AGING }, { label: 'Statement' }]} />
      <Alert
        tone={tone}
        role="alert"
        title={title}
        actions={
          reloadHref !== undefined ? <Link href={reloadHref}>Reload this statement</Link> : null
        }
      >
        {message}
      </Alert>
    </Page>
  );
}

function overdueText(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'} overdue`;
}

function ItemsTable({
  items,
  numberSystem,
}: {
  items: InvoiceSettlement[];
  numberSystem: NumberSystem;
}) {
  return (
    <Table caption="Open items on this statement" minWidth={620}>
      <thead>
        <tr>
          <Th>Invoice</Th>
          <Th>Status</Th>
          <Th>Due date</Th>
          <Th align="end">Invoice total</Th>
          <Th align="end">Open amount</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const meta = settlementMeta(item.settlement);
          return (
            <tr key={item.invoiceId}>
              <Td>
                <Link
                  href={`/invoices/${encodeURIComponent(item.invoiceId)}`}
                  className={`${styles.number} ${styles.wrap}`}
                >
                  {item.number}
                </Link>
              </Td>
              <Td nowrap>
                <Badge tone={meta.tone}>{meta.label}</Badge>
              </Td>
              <Td>
                {item.dueDate !== null ? (
                  <time dateTime={item.dueDate}>{when(item.dueDate, 'date')}</time>
                ) : (
                  <span className={styles.quiet}>No due date</span>
                )}
                {item.daysOverdue > 0 ? (
                  <span className={`${styles.note} ${styles.late}`}>
                    {overdueText(item.daysOverdue)}
                  </span>
                ) : null}
              </Td>
              <Td align="end" nowrap>
                {money(item.total, item.currency, numberSystem)}
              </Td>
              <Td align="end" nowrap>
                <span className={styles.amount}>
                  {money(item.openAmount, item.currency, numberSystem)}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function AdvanceList({
  rows,
  numberSystem,
}: {
  rows: CustomerAdvance[];
  numberSystem: NumberSystem;
}) {
  const held = rows.filter((row) => !isZeroAmount(row.amount));
  if (held.length === 0) return <p className={styles.quiet}>This customer has no advance.</p>;
  return (
    <ul className={styles.advance}>
      {held.map((row) => (
        <li key={row.currency} className={styles.advanceItem}>
          <strong className={styles.advanceValue}>
            {money(row.amount, row.currency, numberSystem)}
          </strong>
          <span className={styles.quiet}>unallocated in {row.currency}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function CustomerStatementPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const here = `/receivables/customers/${id}`;
  const session = await requireStaffSession(here);
  const numberSystem = await getNumberSystem();

  // A person without ar.read is told so without the page fetching anything for them.
  if (!hasPermission(session.roles, 'ar.read')) {
    return (
      <Problem
        tone="info"
        title="Your roles do not include receivables"
        message="Receivables are for the accounts and finance team. Ask an administrator if you need access."
      />
    );
  }

  if (!isGuid(id)) {
    return (
      <Problem title="That is not a customer" message="Open a customer from the aging report." />
    );
  }

  // The name and the advance are context: if either fails the statement still shows. Their
  // rejections are handled here, so one that settles after the statement fails is not unhandled.
  const advanceRequest = getCustomerAdvance(session, id).catch(() => null);
  const customerRequest = getCustomer(session, id).catch(() => null);

  let items: InvoiceSettlement[];
  try {
    items = await getCustomerStatement(session, id, { openOnly: true });
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) {
      return (
        <Problem
          title="Customer not found"
          message="It may have been removed, or it is not in your area."
        />
      );
    }
    if (f.status === 403) {
      return (
        <Problem
          tone="info"
          title="Your roles do not include receivables"
          message="Receivables are for the accounts and finance team. Ask an administrator if you need access."
        />
      );
    }
    return <Problem title="The statement did not load" message={f.message} reloadHref={here} />;
  }

  const [advance, customer] = await Promise.all([advanceRequest, customerRequest]);
  const customerName = customer?.legalName ?? 'Customer details unavailable';

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Receivables', href: AGING }, { label: customerName }]} />
      <PageHeader
        title={customerName}
        description="Customer statement of open invoices and available advances."
        actions={
          <>
            <LinkButton href="/payments" variant="secondary">
              View payments
            </LinkButton>
            {customer?.mergedIntoId === null && hasPermission(session.roles, 'payment.record') && (
              <LinkButton href={`/payments/new?customerId=${encodeURIComponent(id)}`}>
                Record payment
              </LinkButton>
            )}
          </>
        }
      />

      <div className={styles.stack}>
        <Panel title="Open items" description="Outstanding balances and due dates.">
          {items.length === 0 ? (
            <EmptyState icon="banknote" title="Nothing is open for this customer." headingLevel={3}>
              No invoice for this customer has an open amount.
            </EmptyState>
          ) : (
            <ItemsTable numberSystem={numberSystem} items={items} />
          )}
        </Panel>

        <Panel
          as="aside"
          title="Customer advance"
          description="Money the customer has paid that is not yet allocated to an invoice."
        >
          {advance === null ? (
            <Alert tone="warning" role="status">
              The advance could not be loaded. Reload the page to try again.
            </Alert>
          ) : (
            <AdvanceList numberSystem={numberSystem} rows={advance} />
          )}
        </Panel>
      </div>
    </Page>
  );
}
