import { randomUUID } from 'node:crypto';

import type { SalesOrderDetail, ScheduleLineStatus } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { hasPermission } from '@/components/p2/customers/permissions';
import detail from '@/components/p2/quotations/detail.module.css';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { StatusTimeline, type TimelineTone } from '@/components/ui/status-timeline';
import { Table, Td, Th } from '@/components/ui/table';
import { getSalesOrder } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import { DraftInvoiceForm } from '../_components/draft-invoice-form';
import { MarkBillableDialog, type EvidenceOption } from '../_components/mark-billable-dialog';
import local from '../_components/sales-orders.module.css';
import {
  evidenceKindLabel,
  isGuid,
  lineAction,
  salesOrderStatusMeta,
  scheduleLineStatusMeta,
  triggerLabel,
} from '../_lib/status';

export const metadata: Metadata = { title: 'Sales order · Business OS' };
export const dynamic = 'force-dynamic';

type Order = SalesOrderDetail['order'];

const stepTones: Record<ScheduleLineStatus, TimelineTone> = {
  planned: 'upcoming',
  billable: 'current',
  drafted: 'warning',
  invoiced: 'done',
  cancelled: 'muted',
};

function Totals({ order }: { order: Order }) {
  const { totals, currency } = order;
  const rows: { key: string; label: string; value: string; grand?: boolean }[] = [
    { key: 'subtotal', label: 'Subtotal', value: totals.subtotal },
    { key: 'discount', label: 'Discount', value: totals.discountAmount },
    { key: 'taxable', label: 'Taxable amount', value: totals.taxableAmount },
    { key: 'tax', label: 'Tax', value: totals.taxAmount },
    { key: 'total', label: 'Total', value: totals.total, grand: true },
  ];
  return (
    <Panel as="aside" title="Totals" description={`Order amounts in ${currency}.`}>
      <dl className={detail.totals}>
        {rows.map((row) => (
          <div
            key={row.key}
            className={
              row.grand ? `${detail.totalRow} ${detail.grandTotal}` : (detail.totalRow ?? '')
            }
          >
            <dt className={detail.totalTerm}>{row.label}</dt>
            <dd className={detail.totalValue}>{money(row.value, currency)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function summaryFacts(order: Order, deliveryReleased: boolean): Fact[] {
  return [
    {
      key: 'customer',
      label: 'Customer',
      value: <Link href={`/customers/${encodeURIComponent(order.customerId)}`}>View customer</Link>,
    },
    {
      key: 'quotation',
      label: 'Quotation',
      value: (
        <Link href={`/quotations/${encodeURIComponent(order.quotationId)}`}>View quotation</Link>
      ),
    },
    {
      key: 'confirmed',
      label: 'Confirmed on',
      value:
        order.confirmedAt !== null ? (
          <time dateTime={order.confirmedAt}>{when(order.confirmedAt)}</time>
        ) : (
          <span className={local.quiet}>Not confirmed yet</span>
        ),
    },
    {
      key: 'fy',
      label: 'Fiscal year',
      value: order.fiscalYear ?? <span className={local.quiet}>Set when confirmed</span>,
    },
    { key: 'credit', label: 'Credit period', value: `${order.creditDays} days` },
    {
      key: 'delivery',
      label: 'Delivery',
      value: (
        <span className={local.release}>
          <Badge tone={deliveryReleased ? 'success' : 'neutral'}>
            {deliveryReleased ? 'Released' : 'Not released'}
          </Badge>
          <span className={local.meta}>
            Released once the advance invoice has nothing left to pay.
          </span>
        </span>
      ),
    },
  ];
}

function NprSnapshot({ order }: { order: Order }) {
  const { npr } = order;
  const facts: Fact[] = [
    { key: 'amount', label: 'Total in NPR', value: money(npr.amountNpr, 'NPR') },
    { key: 'rate', label: 'Exchange rate', value: <span className={local.id}>{npr.rate}</span> },
    {
      key: 'source',
      label: 'Rate source',
      value: <span className={local.id}>{npr.rateSource}</span>,
    },
    {
      key: 'date',
      label: 'Rate date',
      value: <time dateTime={npr.rateDate}>{npr.rateDate}</time>,
    },
  ];
  return (
    <Panel title="Nepali rupee snapshot" description="Exchange rate at confirmation.">
      <FactList facts={facts} />
    </Panel>
  );
}

function Lines({ data }: { data: SalesOrderDetail }) {
  const { currency } = data.order;
  return (
    <Panel title="Order lines" description="Items from the accepted quotation.">
      {data.lines.length === 0 ? (
        <p className={detail.note}>This order has no lines.</p>
      ) : (
        <Table caption="Order lines" minWidth={860}>
          <thead>
            <tr>
              <Th align="end">No.</Th>
              <Th>Item</Th>
              <Th align="end">Quantity</Th>
              <Th align="end">Unit price</Th>
              <Th align="end">Gross</Th>
              <Th align="end">Discount</Th>
              <Th align="end">Taxable amount</Th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((line) => (
              <tr key={line.lineNo}>
                <Td align="end" nowrap>
                  {line.lineNo}
                </Td>
                <Td>
                  <div className={local.description}>{line.description}</div>
                </Td>
                <Td align="end" nowrap>
                  {line.quantity} {line.uom}
                </Td>
                <Td align="end" nowrap>
                  {money(line.unitPrice, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.gross, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.discountAlloc, currency)}
                </Td>
                <Td align="end" nowrap>
                  {money(line.taxable, currency)}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Schedule({
  data,
  evidence,
  can,
  reloadHref,
}: {
  data: SalesOrderDetail;
  evidence: readonly EvidenceOption[];
  can: { mark: boolean; draft: boolean };
  reloadHref: string;
}) {
  const { order, schedule } = data;
  return (
    <Panel
      title="Billing schedule"
      description="Billable steps, supporting documents and linked invoices."
    >
      {schedule.length === 0 ? (
        <p className={detail.note}>This order has no billing schedule yet.</p>
      ) : (
        <Table caption="Billing schedule" minWidth={880}>
          <thead>
            <tr>
              <Th align="end">Step</Th>
              <Th>Name</Th>
              <Th align="end">Share</Th>
              <Th align="end">Amount</Th>
              <Th>Status</Th>
              <Th>Evidence</Th>
              <Th>Next</Th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((line) => {
              const { label, tone } = scheduleLineStatusMeta(line.status);
              const action = lineAction(order.status, line, can);
              return (
                <tr key={line.id}>
                  <Td align="end" nowrap>
                    {line.seq}
                  </Td>
                  <Td>
                    <span className={local.step}>
                      <span>{line.label}</span>
                      <span className={local.meta}>{triggerLabel(line.trigger)}</span>
                    </span>
                  </Td>
                  <Td align="end" nowrap>
                    {line.percent !== null ? `${line.percent}%` : 'By amount'}
                  </Td>
                  <Td align="end" nowrap>
                    {money(line.amount, order.currency)}
                  </Td>
                  <Td nowrap>
                    <Badge tone={tone}>{label}</Badge>
                  </Td>
                  <Td>
                    {line.billableEvidenceDocumentId !== null ? (
                      <span className={local.step}>
                        <span className={local.id}>Supporting document</span>
                        {line.billableMarkedAt !== null ? (
                          <span className={local.meta}>
                            Marked {when(line.billableMarkedAt, 'date')}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className={local.quiet}>
                        {line.trigger === 'advance' ? 'Not needed' : 'None yet'}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <div className={local.actionCell}>
                      {action === 'mark_billable' ? (
                        <MarkBillableDialog
                          key={order.version}
                          salesOrderId={order.id}
                          scheduleLineId={line.id}
                          lineLabel={line.label}
                          version={order.version}
                          evidence={evidence}
                          idempotencyKey={randomUUID()}
                          reloadHref={reloadHref}
                        />
                      ) : action === 'draft_invoice' ? (
                        <DraftInvoiceForm
                          salesOrderId={order.id}
                          scheduleLineId={line.id}
                          lineLabel={line.label}
                          idempotencyKey={randomUUID()}
                          reloadHref={reloadHref}
                        />
                      ) : action === 'open_invoice' && line.invoiceId !== null ? (
                        <Link href={`/invoices/${encodeURIComponent(line.invoiceId)}`}>
                          Open invoice
                        </Link>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

function Evidence({ items }: { items: SalesOrderDetail['evidence'] }) {
  return (
    <Panel
      title="Evidence"
      description="The documents that back this sale. A billing step cites one of them."
    >
      {items.length === 0 ? (
        <p className={detail.note}>No evidence is attached to this order.</p>
      ) : (
        <ul className={local.evidence}>
          {items.map((item, index) => (
            <li key={item.documentId} className={local.evidenceItem}>
              <span className={local.evidenceKind}>{evidenceKindLabel(item.kind)}</span>
              <span className={`${local.id} ${local.meta}`}>Document {index + 1}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default async function SalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Not an id: no order can have it, so there is nothing to ask the API.
  if (!isGuid(id)) notFound();
  const path = `/sales-orders/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);

  let data: SalesOrderDetail;
  try {
    data = await getSalesOrder(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Sales orders', href: '/sales-orders' }, { label: 'Order' }]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403
              ? 'Your roles do not include sales orders'
              : 'This sales order did not load'
          }
          actions={f.status !== 403 ? <Link href={path}>Try again</Link> : null}
        >
          {f.status === 403
            ? 'Sales orders are for Accounts, Finance and the people who oversee them. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  const { order } = data;
  const { label, tone } = salesOrderStatusMeta(order.status);
  const can = {
    mark: hasPermission(session.roles, 'sales_order.mark_billable'),
    draft: hasPermission(session.roles, 'invoice.draft'),
  };
  const evidence: EvidenceOption[] = data.evidence.map((item, index) => ({
    documentId: item.documentId,
    label: `${evidenceKindLabel(item.kind)} · Document ${index + 1}`,
  }));

  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Sales orders', href: '/sales-orders' },
          { label: order.number ?? 'Draft sales order' },
        ]}
      />
      <PageHeader
        title={<span className={detail.wrap}>{order.number ?? 'Draft sales order'}</span>}
        status={<Badge tone={tone}>{label}</Badge>}
        description={`Sales order · ${money(order.totals.total, order.currency)}`}
      />

      {order.status === 'draft' ? (
        <Alert tone="info" title="This order is a draft.">
          It has no number yet and cannot be billed until it is confirmed.
        </Alert>
      ) : null}

      {data.schedule.length > 0 && (
        <div className={local.progress}>
          <StatusTimeline
            label="Billing milestones"
            steps={data.schedule.map((line) => ({
              key: line.id,
              title: line.label,
              status: scheduleLineStatusMeta(line.status).label,
              tone: stepTones[line.status],
            }))}
          />
        </div>
      )}
      <div className={detail.columns}>
        <Panel title="Order overview">
          <FactList facts={summaryFacts(order, data.deliveryReleased)} />
        </Panel>
        <Totals order={order} />
      </div>

      <Schedule data={data} evidence={evidence} can={can} reloadHref={path} />
      <Lines data={data} />
      <div className={detail.columns}>
        <Evidence items={data.evidence} />
        <NprSnapshot order={order} />
      </div>
    </Page>
  );
}
