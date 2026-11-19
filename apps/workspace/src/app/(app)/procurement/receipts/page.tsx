import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import {
  getPoProgress,
  listReceipts,
  listReceivableOrders,
  listRequestedOrders,
  type PoProgress,
  type ReceivableOrder,
  type Receipt,
  type RequestedOrder,
} from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import type { Session } from '@/lib/session';

import layout from '../procurement.module.css';
import { isReceivable, PO_STATUS_LABEL, qtyText } from '../orders/_lib/model';
import { receiptFailure } from './_lib/failure';
import {
  KIND_LABEL,
  kindsOffered,
  receiptGrants,
  RECEIPT_STATUS_LABEL,
  WAITING_KIND_LABEL,
} from './_lib/model';
import styles from './receipts.module.css';

export const metadata: Metadata = { title: 'Receipts · Business OS' };
export const dynamic = 'force-dynamic';

/** What the picker knows about the orders waiting for receipt: absent when it is not offered. */
type Waiting =
  { state: 'list'; orders: readonly ReceivableOrder[] } | { state: 'failed'; message: string };

/**
 * The receiving list is offered to the warehouse only. A 403 (grants changed since the roles were
 * read) quietly leaves it out; any other failure is shown.
 */
async function loadWaiting(session: Session, mayReceive: boolean): Promise<Waiting | undefined> {
  if (!mayReceive) return undefined;
  try {
    return { state: 'list', orders: await listReceivableOrders(session) };
  } catch (err) {
    const f = receiptFailure(err, 'load');
    if (f.status === 403) return undefined;
    return { state: 'failed', message: f.message };
  }
}

/** What the caller's own orders list knows: absent when the API refuses it or it is empty. */
type Mine =
  { state: 'list'; orders: readonly RequestedOrder[] } | { state: 'failed'; message: string };

/**
 * The orders raised from the caller's own purchase requests (U18 #4): a requester may receive a service on them
 * but holds no purchase order read. The API decides who gets the list; a 403 leaves it out, as does an empty one.
 */
async function loadMine(session: Session): Promise<Mine | undefined> {
  try {
    const orders = await listRequestedOrders(session);
    return orders.length === 0 ? undefined : { state: 'list', orders };
  } catch (err) {
    const f = receiptFailure(err, 'load');
    if (f.status === 403) return undefined;
    return { state: 'failed', message: f.message };
  }
}

function MyOrders({ orders }: { orders: readonly RequestedOrder[] }) {
  return (
    <Panel
      title="Your purchase orders"
      description="Orders raised from your purchase requests, newest first. Open one to see what has arrived or to record a service you received."
    >
      <Table
        className={layout.panelTable ?? ''}
        caption="Purchase orders of your purchase requests"
        minWidth={640}
      >
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>Vendor</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const status = PO_STATUS_LABEL[o.status];
            return (
              <tr key={o.id}>
                <Td nowrap>
                  <Link
                    href={`/procurement/receipts?po=${encodeURIComponent(o.id)}`}
                    className={styles.name}
                  >
                    {o.number}
                  </Link>
                </Td>
                <Td>
                  <span className={styles.long}>{o.vendorName}</span>
                </Td>
                <Td nowrap>
                  <Badge tone={status.tone}>{status.text}</Badge>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Panel>
  );
}

function WaitingOrders({ orders }: { orders: readonly ReceivableOrder[] }) {
  return (
    <Panel
      title="Waiting to be received"
      description="Issued and partly received purchase orders, newest first. Open one to see its receipts, or start a receipt straight away."
    >
      {orders.length === 0 ? (
        <EmptyState
          title="No purchase orders are waiting to be received"
          icon="file-text"
          headingLevel={3}
        >
          Orders appear here once they are issued, and leave when everything has arrived.
        </EmptyState>
      ) : (
        <Table
          className={layout.panelTable ?? ''}
          caption="Purchase orders waiting to be received"
          minWidth={900}
        >
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Vendor</Th>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th>Issued</Th>
              <Th align="end">Still open</Th>
              <Th>
                <span className={styles.srOnly}>Start a receipt</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const status = PO_STATUS_LABEL[o.status];
              return (
                <tr key={o.id}>
                  <Td>
                    <Link
                      href={`/procurement/receipts?po=${encodeURIComponent(o.id)}`}
                      className={styles.name}
                    >
                      {o.number}
                    </Link>
                  </Td>
                  <Td>
                    <span className={styles.long}>{o.vendorName}</span>
                  </Td>
                  <Td nowrap>{WAITING_KIND_LABEL[o.kind]}</Td>
                  <Td nowrap>
                    <Badge tone={status.tone}>{status.text}</Badge>
                  </Td>
                  <Td nowrap>
                    {o.issuedAt !== undefined ? (
                      <time dateTime={o.issuedAt}>{when(o.issuedAt, 'date')}</time>
                    ) : (
                      <span className={styles.quiet}>Not recorded</span>
                    )}
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>{qtyText(o.openQuantity)}</span>
                  </Td>
                  <Td align="end" nowrap>
                    <LinkButton
                      href={`/procurement/receipts/new?po=${encodeURIComponent(o.id)}`}
                      variant="secondary"
                      size="small"
                      aria-label={`New receipt for ${o.number}`}
                    >
                      New receipt
                    </LinkButton>
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

function Picker({
  invalid,
  canOpenOrders,
  waiting,
  mine,
}: {
  invalid: boolean;
  canOpenOrders: boolean;
  waiting: Waiting | undefined;
  mine: Mine | undefined;
}) {
  const offered = waiting !== undefined || mine !== undefined || canOpenOrders;
  return (
    <Page width={waiting?.state === 'list' ? 'full' : 'narrow'} className={layout.detail}>
      <PageHeader
        title="Receipts"
        description="Goods and services are received against one purchase order. Pick the order below."
      />
      <div className={layout.stack}>
        {invalid ? (
          <Alert tone="warning" role="alert" title="That link does not name a purchase order">
            Pick the order below, or open it again from the page that linked here.
          </Alert>
        ) : null}
        {waiting?.state === 'failed' ? (
          <Alert tone="error" role="alert" title="The waiting orders did not load">
            {waiting.message}
          </Alert>
        ) : null}
        {mine?.state === 'failed' ? (
          <Alert tone="error" role="alert" title="Your purchase orders did not load">
            {mine.message}
          </Alert>
        ) : null}
        {waiting?.state === 'list' ? <WaitingOrders orders={waiting.orders} /> : null}
        {mine?.state === 'list' ? <MyOrders orders={mine.orders} /> : null}
        {canOpenOrders ? (
          <p className={styles.note}>
            Open an order&apos;s receipts from{' '}
            <Link href="/procurement/orders">the purchase order list</Link>.
          </p>
        ) : null}
        {!offered ? (
          <EmptyState title="No purchase orders to open" icon="file-text" headingLevel={2}>
            The orders raised from your purchase requests appear here once they are issued.
          </EmptyState>
        ) : null}
      </div>
    </Page>
  );
}

function PanelProblem({ err }: { err: unknown }) {
  const f = receiptFailure(err, 'load');
  return f.status === 403 ? (
    <Alert tone="info" role="status" title="Your roles do not include the order's progress">
      What is still open on an order is shown to the warehouse and the procurement team.
    </Alert>
  ) : (
    <Alert tone="error" role="alert" title="The order's progress did not load">
      {f.message}
    </Alert>
  );
}

function Progress({ progress }: { progress: PoProgress }) {
  return (
    <Panel
      title="Where the order stands"
      description="What was ordered, what has arrived, and what is still open. Draft receipts hold their quantity until they are confirmed."
    >
      <Table
        className={layout.panelTable ?? ''}
        caption="Receipt progress by purchase order line"
        minWidth={820}
      >
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Item</Th>
            <Th align="end">Ordered</Th>
            <Th align="end">Received</Th>
            <Th align="end">Waiting in drafts</Th>
            <Th align="end">Still open</Th>
          </tr>
        </thead>
        <tbody>
          {progress.lines.map((l) => (
            <tr key={l.poLineId}>
              <Td nowrap>{l.lineNo}</Td>
              <Td>
                <span className={styles.long}>{l.description}</span>
                <span className={styles.note}>
                  {' '}
                  {l.kind === 'service' ? 'Service' : 'Goods'}
                  {l.requiresSerials ? ', serial numbers tracked' : ''}
                </span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>
                  {qtyText(l.orderedQuantity)} {l.uom}
                </span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>{qtyText(l.receivedQuantity)}</span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>{qtyText(l.pendingQuantity)}</span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>{qtyText(l.openQuantity)}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function ReceiptRows({ receipts }: { receipts: readonly Receipt[] }) {
  const numberOf = new Map(receipts.map((r) => [r.id, r.number]));
  return (
    <Table
      className={layout.panelTable ?? ''}
      caption="Receipts of this purchase order"
      minWidth={820}
    >
      <thead>
        <tr>
          <Th>Receipt</Th>
          <Th>Kind</Th>
          <Th>Status</Th>
          <Th>Received on</Th>
          <Th>Location</Th>
          <Th align="end">Lines</Th>
        </tr>
      </thead>
      <tbody>
        {receipts.map((r) => {
          const status = RECEIPT_STATUS_LABEL[r.status];
          return (
            <tr key={r.id}>
              <Td>
                <Link
                  href={`/procurement/receipts/${encodeURIComponent(r.id)}`}
                  className={styles.name}
                >
                  {r.number}
                </Link>
                {r.reversesReceiptId !== null ? (
                  <span className={styles.note}>
                    {' '}
                    Reversal of {numberOf.get(r.reversesReceiptId) ?? 'an earlier receipt'}
                  </span>
                ) : null}
              </Td>
              <Td nowrap>{KIND_LABEL[r.kind]}</Td>
              <Td nowrap>
                <Badge tone={status.tone}>{status.text}</Badge>
              </Td>
              <Td nowrap>
                <time dateTime={r.receivedAt}>{when(r.receivedAt, 'date')}</time>
              </Td>
              <Td>
                {r.location !== null ? (
                  <span className={styles.long}>{r.location}</span>
                ) : (
                  <span className={styles.quiet}>Not recorded</span>
                )}
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>{r.lines.length}</span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ po?: string | string[] }>;
}) {
  const params = await searchParams;
  const po = typeof params.po === 'string' ? params.po.trim() : '';

  // Without a valid purchase order ID there is nothing to list, and nothing reaches the API.
  if (!isGuid(po)) {
    const session = await requireStaffSession('/procurement/receipts');
    const grants = receiptGrants(session.roles);
    const [waiting, mine] = await Promise.all([
      loadWaiting(session, grants.confirm),
      loadMine(session),
    ]);
    return (
      <Picker invalid={po !== ''} canOpenOrders={grants.issue} waiting={waiting} mine={mine} />
    );
  }

  const here = `/procurement/receipts?po=${po}`;
  const session = await requireStaffSession(here);
  const grants = receiptGrants(session.roles);
  const [receipts, progress] = await Promise.allSettled([
    listReceipts(session, po),
    getPoProgress(session, po),
  ]);

  if (receipts.status === 'rejected') {
    const f = receiptFailure(receipts.reason as unknown, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Receipts' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open these receipts' : 'The receipts did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const order = progress.status === 'fulfilled' ? progress.value : undefined;
  const label = order?.number ?? 'this purchase order';
  // With the progress known, offer a new receipt only where it can work; unknown leaves it to the form.
  const mayStart =
    order === undefined
      ? true
      : isReceivable(order.status) && kindsOffered(order.lines, grants).length > 0;
  const newHref = `/procurement/receipts/new?po=${encodeURIComponent(po)}`;

  return (
    <Page className={layout.detail}>
      <div className={layout.detailHeader}>
        <Breadcrumb
          items={
            grants.issue
              ? [
                  { label: 'Purchase orders', href: '/procurement/orders' },
                  {
                    label: order?.number ?? 'Purchase order',
                    href: `/procurement/orders/${encodeURIComponent(po)}`,
                  },
                  { label: 'Receipts' },
                ]
              : [{ label: 'Receipts' }]
          }
        />
        <PageHeader
          title={
            <>Receipts{order ? <span className={styles.long}> for {order.number}</span> : null}</>
          }
          status={
            order ? (
              <Badge tone={PO_STATUS_LABEL[order.status].tone}>
                {PO_STATUS_LABEL[order.status].text}
              </Badge>
            ) : undefined
          }
          description="A receipt records what arrived. It starts as a draft and counts once it is confirmed. A mistake is undone by reversing the receipt, never by editing it."
          actions={
            mayStart ? (
              <LinkButton href={newHref} variant="primary">
                New receipt
              </LinkButton>
            ) : null
          }
        />
      </div>

      <div className={layout.stack}>
        <Panel title="Receipts">
          {receipts.value.length === 0 ? (
            <EmptyState
              title="Nothing has been received yet."
              icon="file-text"
              headingLevel={3}
              action={
                mayStart ? (
                  <LinkButton href={newHref} variant="secondary">
                    New receipt
                  </LinkButton>
                ) : undefined
              }
            >
              Receipts of {label} appear here, newest first.
            </EmptyState>
          ) : (
            <ReceiptRows receipts={receipts.value} />
          )}
        </Panel>
        {progress.status === 'fulfilled' ? (
          <Progress progress={progress.value} />
        ) : (
          <PanelProblem err={progress.reason as unknown} />
        )}
      </div>
    </Page>
  );
}
