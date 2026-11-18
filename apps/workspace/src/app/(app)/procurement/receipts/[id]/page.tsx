import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { SuccessNotice } from '@/components/p4/success-notice';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import {
  getPoProgress,
  getReceipt,
  listReceipts,
  type PoProgress,
  type Receipt,
} from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import layout from '../../procurement.module.css';
import { isReceivable, PO_STATUS_LABEL, qtyText } from '../../orders/_lib/model';
import { ConfirmDialog, ReverseDialog, DiscardReceiptDialog } from '../_components/receipt-actions';
import { receiptFailure } from '../_lib/failure';
import {
  KIND_LABEL,
  mayHandleKind,
  receiptActions,
  receiptGrants,
  RECEIPT_STATUS_LABEL,
} from '../_lib/model';
import styles from '../receipts.module.css';

export const metadata: Metadata = { title: 'Receipt · Business OS' };
export const dynamic = 'force-dynamic';

function Lines({
  receipt,
  progress,
}: {
  receipt: Receipt;
  progress: PromiseSettledResult<PoProgress>;
}) {
  const byLine = new Map(
    progress.status === 'fulfilled' ? progress.value.lines.map((l) => [l.poLineId, l]) : [],
  );
  return (
    <Panel
      title="Lines"
      description={
        receipt.reversesReceiptId !== null
          ? 'A reversal takes back what the earlier receipt brought in, so its quantities are negative.'
          : 'What arrived on each line. Quantities are as the server recorded them.'
      }
    >
      <Table className={layout.panelTable ?? ''} caption="Receipt lines" minWidth={720}>
        <thead>
          <tr>
            <Th align="end">#</Th>
            <Th>Item</Th>
            <Th align="end">Quantity</Th>
            <Th>Checks</Th>
          </tr>
        </thead>
        <tbody>
          {receipt.lines.map((l) => {
            const item = byLine.get(l.poLineId);
            return (
              <tr key={l.id}>
                <Td align="end" nowrap>
                  {l.lineNo}
                </Td>
                <Td>
                  <span className={styles.long}>{item?.description ?? 'Purchase order line'}</span>
                  {l.serials.length > 0 ? (
                    <details className={styles.serials}>
                      <summary>
                        {l.serials.length} serial number{l.serials.length === 1 ? '' : 's'}
                      </summary>
                      <ul className={styles.serialList}>
                        {l.serials.map((s) => (
                          <li key={s.serialNo}>{s.serialNo}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>
                    {qtyText(l.quantity)}
                    {item !== undefined ? ` ${item.uom}` : ''}
                  </span>
                </Td>
                <Td>
                  {l.inspection === null && l.discrepancyNote === null ? (
                    <span className={styles.quiet}>None noted</span>
                  ) : (
                    <>
                      {l.inspection !== null ? (
                        <span className={styles.long}>Inspection: {l.inspection}. </span>
                      ) : null}
                      {l.discrepancyNote !== null ? (
                        <span className={styles.long}>Discrepancy: {l.discrepancyNote}</span>
                      ) : null}
                    </>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ created?: string | string[] }>;
}) {
  const { id } = await params;
  // An id that is not a GUID cannot be a receipt, so it never reaches the API.
  if (!isGuid(id)) notFound();
  const justCreated = searchParams !== undefined && (await searchParams).created === '1';
  const here = `/procurement/receipts/${id}`;
  const session = await requireStaffSession(here);

  let receipt: Receipt;
  try {
    receipt = await getReceipt(session, id);
  } catch (err) {
    const f = receiptFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Receipts' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this receipt' : 'This receipt did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  // Both are context only: a failure leaves the receipt and its buttons usable.
  const [progress, siblings] = await Promise.allSettled([
    getPoProgress(session, receipt.purchaseOrderId),
    listReceipts(session, receipt.purchaseOrderId),
  ]);
  const order = progress.status === 'fulfilled' ? progress.value : undefined;
  const others = siblings.status === 'fulfilled' ? siblings.value : [];

  const grants = receiptGrants(session.roles);
  const can = receiptActions(receipt, grants, order?.status);
  const status = RECEIPT_STATUS_LABEL[receipt.status];
  const listHref = `/procurement/receipts?po=${encodeURIComponent(receipt.purchaseOrderId)}`;
  const orderHref = grants.issue
    ? `/procurement/orders/${encodeURIComponent(receipt.purchaseOrderId)}`
    : listHref;
  const reversal =
    receipt.status === 'reversed'
      ? others.find((r) => r.reversesReceiptId === receipt.id)
      : undefined;
  const original =
    receipt.reversesReceiptId !== null
      ? others.find((r) => r.id === receipt.reversesReceiptId)
      : undefined;
  const common = { receiptId: receipt.id, number: receipt.number, reloadHref: here };

  const facts: Fact[] = [
    {
      key: 'order',
      label: 'Purchase order',
      value: <Link href={orderHref}>{order?.number ?? 'Open the purchase order'}</Link>,
    },
    { key: 'kind', label: 'Kind', value: KIND_LABEL[receipt.kind] },
    {
      key: 'receivedAt',
      label: 'Received on',
      value: <time dateTime={receipt.receivedAt}>{when(receipt.receivedAt, 'date')}</time>,
    },
    {
      key: 'location',
      label: 'Location',
      value:
        receipt.location !== null ? (
          <span className={styles.long}>{receipt.location}</span>
        ) : (
          <span className={styles.quiet}>Not recorded</span>
        ),
    },
    {
      key: 'created',
      label: 'Saved',
      value: <time dateTime={receipt.createdAt}>{when(receipt.createdAt)}</time>,
    },
    {
      key: 'confirmed',
      label: 'Confirmed',
      value:
        receipt.confirmedAt !== null ? (
          <time dateTime={receipt.confirmedAt}>{when(receipt.confirmedAt)}</time>
        ) : (
          <span className={styles.quiet}>Not yet</span>
        ),
    },
    ...(receipt.reversesReceiptId !== null
      ? [
          {
            key: 'reverses',
            label: 'Reverses',
            value: (
              <Link href={`/procurement/receipts/${encodeURIComponent(receipt.reversesReceiptId)}`}>
                {original?.number ?? 'The earlier receipt'}
              </Link>
            ),
          },
        ]
      : []),
    ...(receipt.reversalReason !== null
      ? [
          {
            key: 'reason',
            label: 'Reason for the reversal',
            value: <span className={styles.long}>{receipt.reversalReason}</span>,
            wide: true,
          },
        ]
      : []),
  ];

  const stuckDraft =
    receipt.status === 'draft' && order !== undefined && !isReceivable(order.status);
  const canDiscard = receipt.status === 'draft' && mayHandleKind(receipt.kind, grants);

  return (
    <Page className={layout.detail}>
      <div className={layout.detailHeader}>
        <Breadcrumb items={[{ label: 'Receipts', href: listHref }, { label: receipt.number }]} />
        <PageHeader
          title={<span className={styles.long}>{receipt.number}</span>}
          status={<Badge tone={status.tone}>{status.text}</Badge>}
          actions={
            can.confirm || can.reverse || canDiscard ? (
              <div className={styles.headActions}>
                {can.confirm ? <ConfirmDialog {...common} idempotencyKey={randomUUID()} /> : null}
                {can.reverse ? <ReverseDialog {...common} idempotencyKey={randomUUID()} /> : null}
                {canDiscard ? (
                  <DiscardReceiptDialog {...common} idempotencyKey={randomUUID()} />
                ) : null}
              </div>
            ) : null
          }
        />
      </div>

      {justCreated && receipt.status === 'draft' ? (
        <SuccessNotice message="The draft receipt was saved." />
      ) : null}
      {receipt.status === 'draft' && !stuckDraft ? (
        <Alert tone="info" role="status">
          This draft counts as received on the purchase order once it is confirmed.
        </Alert>
      ) : null}
      {stuckDraft && order !== undefined ? (
        <Alert tone="warning" role="status" title="This draft cannot be confirmed now">
          {order.number} is {PO_STATUS_LABEL[order.status].text.toLowerCase()}, and only an issued
          or partly received order takes receipts.
        </Alert>
      ) : null}
      {receipt.status === 'draft' && !mayHandleKind(receipt.kind, grants) ? (
        <Alert tone="info" role="status" title="Confirming goods is for the warehouse">
          You can read this draft, but a colleague in the warehouse role has to confirm it.
        </Alert>
      ) : null}
      {receipt.status === 'reversed' ? (
        <Alert tone="warning" role="status" title="This receipt was reversed">
          {reversal !== undefined ? (
            <>
              <Link href={`/procurement/receipts/${encodeURIComponent(reversal.id)}`}>
                {reversal.number}
              </Link>{' '}
              took its quantities back
              {reversal.reversalReason !== null ? (
                <>
                  : <span className={styles.long}>{reversal.reversalReason}</span>
                </>
              ) : null}
              .
            </>
          ) : (
            'A reversal receipt took its quantities back.'
          )}
        </Alert>
      ) : null}
      {progress.status === 'rejected' &&
      receiptFailure(progress.reason as unknown, 'load').status !== 403 ? (
        <Alert tone="warning" role="status" title="The order's details did not load">
          The receipt is shown without the order number and item names.
        </Alert>
      ) : null}

      <div className={layout.detailColumns}>
        <Panel title="Receipt details">
          <FactList
            facts={facts.filter((fact) => !(fact.key === 'order' || fact.key === 'reverses'))}
          />
        </Panel>
        <Panel as="aside" title="Linked records" className={layout.linkedRecords}>
          <FactList
            facts={facts.filter((fact) => fact.key === 'order' || fact.key === 'reverses')}
          />
        </Panel>
      </div>

      <Lines receipt={receipt} progress={progress} />
    </Page>
  );
}
