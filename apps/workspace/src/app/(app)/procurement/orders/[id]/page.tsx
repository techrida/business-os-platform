import { randomUUID } from 'node:crypto';

import { trimPercent } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import {
  getPoProgress,
  getPurchaseOrder,
  listPoVersions,
  type PoProgress,
  type PoProgressLine,
  type PoVersion,
  type PurchaseOrder,
} from '@/lib/api-purchase-orders';
import { getVendor } from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import layout from '../../procurement.module.css';
import { AmendDialog, IssueDialog, ReasonDialog } from '../_components/order-actions';
import { poFailure } from '../_lib/failure';
import {
  isReceivable,
  orderActions,
  PO_STATUS_LABEL,
  poGrants,
  poMoney,
  qtyText,
} from '../_lib/model';
import styles from '../orders.module.css';

export const metadata: Metadata = { title: 'Purchase order · Business OS' };
export const dynamic = 'force-dynamic';

function PanelProblem({ what, err, retry }: { what: string; err: unknown; retry: string }) {
  const f = poFailure(err, 'load');
  return f.status === 403 ? (
    <Alert tone="info" role="status" title={`Your roles do not include ${what}`}>
      {what.charAt(0).toUpperCase() + what.slice(1)} are for the procurement team.
    </Alert>
  ) : (
    <Alert
      tone="error"
      role="alert"
      title={`The ${what} did not load`}
      actions={<Link href={retry}>Try again</Link>}
    >
      {f.message}
    </Alert>
  );
}

function Lines({
  po,
  progress,
}: {
  po: PurchaseOrder;
  progress: PromiseSettledResult<PoProgress>;
}) {
  const byLine = new Map<string, PoProgressLine>();
  if (progress.status === 'fulfilled') {
    for (const l of progress.value.lines) byLine.set(l.poLineId, l);
  }
  const withProgress = progress.status === 'fulfilled';
  return (
    <Panel
      className={styles.tablePanel}
      title="Lines"
      description={
        withProgress
          ? 'What was ordered, what has arrived, and what is still open. Amounts are as the server worked them out.'
          : 'What was ordered. Amounts are as the server worked them out.'
      }
    >
      {po.lines.length === 0 ? (
        <EmptyState title="This order has no lines." icon="file-text" headingLevel={3}>
          A purchase order needs at least one line before it can be issued.
        </EmptyState>
      ) : (
        <Table
          className={layout.panelTable ?? ''}
          caption="Purchase order lines"
          minWidth={withProgress ? 980 : 720}
        >
          <thead>
            <tr>
              <Th align="end">#</Th>
              <Th>Item</Th>
              <Th align="end">Ordered</Th>
              {withProgress ? (
                <>
                  <Th align="end">Received</Th>
                  <Th align="end">Waiting in drafts</Th>
                  <Th align="end">Still open</Th>
                </>
              ) : null}
              <Th align="end">Unit price</Th>
              <Th align="end">Tax</Th>
              <Th align="end">Line total</Th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => {
              const p = byLine.get(l.id);
              return (
                <tr key={l.id}>
                  <Td align="end" nowrap>
                    {l.lineNo}
                  </Td>
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
                    {l.cancelledQuantity !== '0.0000' ? (
                      <span className={styles.note}>
                        {' '}
                        ({qtyText(l.cancelledQuantity)} cancelled)
                      </span>
                    ) : null}
                  </Td>
                  {withProgress ? (
                    <>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>
                          {qtyText(p?.receivedQuantity ?? '0')}
                        </span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>{qtyText(p?.pendingQuantity ?? '0')}</span>
                      </Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>{qtyText(p?.openQuantity ?? '0')}</span>
                      </Td>
                    </>
                  ) : null}
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>{poMoney(l.unitPrice, po.currency)}</span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>{poMoney(l.taxAmount, po.currency)}</span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>{poMoney(l.lineTotal, po.currency)}</span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {progress.status === 'rejected' ? (
        <PanelProblem
          what="receipt progress"
          err={progress.reason as unknown}
          retry={`/procurement/orders/${po.id}`}
        />
      ) : null}
    </Panel>
  );
}

function Versions({
  po,
  result,
  here,
}: {
  po: PurchaseOrder;
  result: PromiseSettledResult<PoVersion[]>;
  here: string;
}) {
  return (
    <Panel
      className={styles.tablePanel}
      title="Versions"
      description="Every issued version stays as it was. Each has its own PDF."
    >
      {result.status === 'rejected' ? (
        <PanelProblem what="versions" err={result.reason as unknown} retry={here} />
      ) : result.value.length === 0 ? (
        <EmptyState title="Not issued yet." icon="file-text" headingLevel={3}>
          Version 1 and its PDF appear when the order is issued.
        </EmptyState>
      ) : (
        <Table className={layout.panelTable ?? ''} caption="Purchase order versions" minWidth={720}>
          <thead>
            <tr>
              <Th align="end">Version</Th>
              <Th>Why</Th>
              <Th align="end">Total</Th>
              <Th align="end">Total in NPR</Th>
              <Th>Band</Th>
              <Th>Issued</Th>
              <Th>PDF</Th>
            </tr>
          </thead>
          <tbody>
            {[...result.value].reverse().map((v) => (
              <tr key={v.id}>
                <Td align="end" nowrap>
                  v{v.version}
                  {v.version === po.currentVersion ? <Badge tone="info"> Current</Badge> : null}
                </Td>
                <Td>
                  {v.reason !== null ? (
                    <span className={styles.long}>{v.reason}</span>
                  ) : (
                    <span className={styles.quiet}>First issue</span>
                  )}
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>{poMoney(v.total, po.currency)}</span>
                </Td>
                <Td align="end" nowrap>
                  <span className={styles.numeric}>{poMoney(v.totalNpr, 'NPR')}</span>
                </Td>
                <Td nowrap>{v.band}</Td>
                <Td nowrap>
                  <time dateTime={v.createdAt}>{when(v.createdAt)}</time>
                </Td>
                <Td nowrap>
                  <a
                    href={`/procurement/orders/${encodeURIComponent(po.id)}/versions/${v.version}/document`}
                    className={styles.versionLink}
                  >
                    Download PDF<span className="sr-only"> of version {v.version}</span>
                  </a>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Panel>
  );
}

export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // An id that is not a GUID cannot be a purchase order, so it never reaches the API.
  if (!isGuid(id)) notFound();
  const here = `/procurement/orders/${id}`;
  const session = await requireStaffSession(here);

  let po: PurchaseOrder;
  try {
    po = await getPurchaseOrder(session, id);
  } catch (err) {
    const f = poFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[
            { label: 'Purchase orders', href: '/procurement/orders' },
            { label: 'Purchase order' },
          ]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403
              ? 'You cannot open this purchase order'
              : 'This purchase order did not load'
          }
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.status === 403
            ? 'Purchase orders are for the procurement team. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  // The panels load on their own: one failing leaves the rest usable.
  const [versions, progress, vendor] = await Promise.allSettled([
    listPoVersions(session, id),
    getPoProgress(session, id),
    getVendor(session, po.vendorId),
  ]);

  const grants = poGrants(session.roles);
  const can = orderActions(po.status, grants);
  const status = PO_STATUS_LABEL[po.status];
  const current =
    versions.status === 'fulfilled'
      ? versions.value.find((v) => v.version === po.currentVersion)
      : undefined;
  const hasServiceLines = po.lines.some((l) => l.kind === 'service');
  const mayReceive = isReceivable(po.status) && (grants.confirm || hasServiceLines);
  const received = (lineId: string): string | null =>
    progress.status === 'fulfilled'
      ? (progress.value.lines.find((l) => l.poLineId === lineId)?.receivedQuantity ?? null)
      : null;

  const common = {
    purchaseOrderId: po.id,
    number: po.number,
    reloadHref: here,
  };

  const facts: Fact[] = [
    {
      key: 'vendor',
      label: 'Vendor',
      value:
        vendor.status === 'fulfilled' ? (
          <Link href={`/vendors/${encodeURIComponent(po.vendorId)}`} className={styles.long}>
            {vendor.value.legalName}
          </Link>
        ) : (
          <Link href={`/vendors/${encodeURIComponent(po.vendorId)}`}>Vendor name unavailable</Link>
        ),
    },
    {
      key: 'total',
      label: current !== undefined ? `Total, version ${current.version}` : 'Approved total',
      value: (
        <span className={styles.numeric}>
          {poMoney(current?.total ?? po.approvedTotal, po.currency)}
        </span>
      ),
    },
    {
      key: 'totalNpr',
      label: 'Total in NPR',
      value: (
        <span className={styles.numeric}>
          {poMoney(current?.totalNpr ?? po.approvedTotalNpr, 'NPR')}
        </span>
      ),
    },
    { key: 'band', label: 'Approved band', value: po.approvedBand },
    {
      key: 'terms',
      label: 'Payment terms',
      value: <span className={styles.numeric}>{po.paymentTermsDays} days</span>,
    },
    { key: 'currency', label: 'Currency', value: `${po.currency} (rate ${po.fxRate})` },
    {
      key: 'advance',
      label: 'Advance',
      value: <span className={styles.numeric}>{trimPercent(po.advancePercent)}%</span>,
    },
    {
      key: 'issued',
      label: 'Issued',
      value:
        po.issuedAt !== null ? (
          <time dateTime={po.issuedAt}>{when(po.issuedAt)}</time>
        ) : (
          <span className={styles.quiet}>Not yet</span>
        ),
    },
    ...(po.closedReason !== null
      ? [
          {
            key: 'closed',
            label: 'Reason it ended',
            value: <span className={styles.long}>{po.closedReason}</span>,
            wide: true,
          },
        ]
      : []),
  ];

  return (
    <Page className={layout.detail}>
      <div className={layout.detailHeader}>
        <Breadcrumb
          items={[{ label: 'Purchase orders', href: '/procurement/orders' }, { label: po.number }]}
        />
        <PageHeader
          title={<span className={styles.long}>{po.number}</span>}
          status={<Badge tone={status.tone}>{status.text}</Badge>}
          actions={
            <div className={styles.headActions}>
              {can.issue ? <IssueDialog {...common} idempotencyKey={randomUUID()} /> : null}
              {can.amend ? (
                <AmendDialog
                  {...common}
                  idempotencyKey={randomUUID()}
                  currency={po.currency}
                  paymentTermsDays={po.paymentTermsDays}
                  lines={po.lines.map((l) => ({
                    id: l.id,
                    lineNo: l.lineNo,
                    description: l.description,
                    uom: l.uom,
                    orderedQuantity: l.orderedQuantity,
                    unitPrice: l.unitPrice,
                    cancelledQuantity: l.cancelledQuantity,
                    received: received(l.id),
                  }))}
                />
              ) : null}
              {can.shortClose ? (
                <ReasonDialog kind="shortClose" {...common} idempotencyKey={randomUUID()} />
              ) : null}
              {can.cancel ? (
                <ReasonDialog kind="cancel" {...common} idempotencyKey={randomUUID()} />
              ) : null}
              {mayReceive ? (
                <LinkButton
                  href={`/procurement/receipts/new?po=${encodeURIComponent(po.id)}`}
                  variant="secondary"
                >
                  Receive goods
                </LinkButton>
              ) : null}
              {po.status !== 'draft' ? (
                <LinkButton
                  href={`/procurement/receipts?po=${encodeURIComponent(po.id)}`}
                  variant="ghost"
                >
                  Receipts
                </LinkButton>
              ) : null}
            </div>
          }
        />
      </div>

      {po.status === 'amendment_pending' ? (
        <Alert tone="warning" role="status" title="An amendment is waiting for approval">
          This order stays as it was, and no action is open on it, until the approvers decide. New
          receipts are paused until then.
        </Alert>
      ) : null}

      <div className={layout.detailColumns}>
        <Panel title="Order details">
          <FactList facts={facts.filter((fact) => !(fact.key === 'vendor'))} />
        </Panel>
        <Panel as="aside" title="Linked records" className={layout.linkedRecords}>
          <FactList facts={facts.filter((fact) => fact.key === 'vendor')} />
        </Panel>
      </div>

      <Lines po={po} progress={progress} />
      <Versions po={po} result={versions} here={here} />
    </Page>
  );
}
