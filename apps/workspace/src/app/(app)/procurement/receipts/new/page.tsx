import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { isGuid } from '@/components/p2/customers/format';
import { kathmanduToday } from '@/components/p2/quotations/eligibility';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { getPoProgress, type PoProgress } from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';

import layout from '../../procurement.module.css';
import { isReceivable, PO_STATUS_LABEL, qtyText } from '../../orders/_lib/model';
import { ReceiptForm, type FormLine } from '../_components/receipt-form';
import { receiptFailure } from '../_lib/failure';
import { capText, kindsOffered, lineCap, receiptGrants } from '../_lib/model';

export const metadata: Metadata = { title: 'New receipt · Business OS' };
export const dynamic = 'force-dynamic';

function Shell({ po, number, children }: { po: string; number?: string; children: ReactNode }) {
  const back = `/procurement/receipts?po=${encodeURIComponent(po)}`;
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Receipts', href: back }, { label: 'New receipt' }]} />
      <PageHeader
        title="New receipt"
        description={
          number !== undefined
            ? `Record what arrived on ${number}. Only what is still open can be received.`
            : 'Record what arrived on a purchase order.'
        }
      />
      {children}
    </Page>
  );
}

export default async function NewReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ po?: string | string[] }>;
}) {
  const params = await searchParams;
  const po = typeof params.po === 'string' ? params.po.trim() : '';
  // A receipt belongs to one purchase order: without a valid ID, go and choose one.
  if (!isGuid(po)) redirect('/procurement/receipts');

  const session = await requireStaffSession(`/procurement/receipts/new?po=${po}`);
  const grants = receiptGrants(session.roles);
  const back = `/procurement/receipts?po=${encodeURIComponent(po)}`;

  let progress: PoProgress;
  try {
    progress = await getPoProgress(session, po);
  } catch (err) {
    const f = receiptFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Shell po={po}>
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot receive on this order' : 'The order did not load'}
          actions={
            f.status !== 403 ? <a href={`/procurement/receipts/new?po=${po}`}>Try again</a> : null
          }
        >
          {f.message}
        </Alert>
      </Shell>
    );
  }

  if (!isReceivable(progress.status)) {
    return (
      <Shell po={po} number={progress.number}>
        <Alert
          tone="info"
          role="status"
          title={`${progress.number} takes no new receipts`}
          actions={<a href={back}>Back to its receipts</a>}
        >
          It is {PO_STATUS_LABEL[progress.status].text.toLowerCase()}. An order takes receipts only
          while it is issued or partly received.
        </Alert>
      </Shell>
    );
  }

  const kinds = kindsOffered(progress.lines, grants);
  const [firstKind, ...otherKinds] = kinds;
  if (firstKind === undefined) {
    const anyRoom = progress.lines.some((l) => lineCap(l) > 0n);
    return (
      <Shell po={po} number={progress.number}>
        {anyRoom ? (
          <Alert tone="info" role="status" title="Your roles do not include receiving goods">
            What is still open on this order is goods, which the warehouse receives. A service can
            be confirmed by the person who raised the purchase request.
          </Alert>
        ) : (
          <EmptyState
            title="Nothing is left to receive."
            icon="check-circle"
            action={<LinkButton href={back}>Back to the receipts</LinkButton>}
          >
            Everything ordered has been received or is held by a draft receipt. A draft holds its
            quantity until it is confirmed.
          </EmptyState>
        )}
      </Shell>
    );
  }

  const lines: FormLine[] = progress.lines.map((l) => ({
    poLineId: l.poLineId,
    lineNo: l.lineNo,
    kind: l.kind,
    description: l.description,
    uom: l.uom,
    requiresSerials: l.requiresSerials,
    ordered: qtyText(l.orderedQuantity),
    received: qtyText(l.receivedQuantity),
    pending: qtyText(l.pendingQuantity),
    cap: capText(l),
    hasRoom: lineCap(l) > 0n,
  }));

  return (
    <Page className={layout.formPage}>
      <Breadcrumb items={[{ label: 'Receipts', href: back }, { label: 'New receipt' }]} />
      <ReceiptForm
        purchaseOrderId={po}
        number={progress.number}
        // One key per render of this page: a double click or a retry creates the receipt once.
        idempotencyKey={randomUUID()}
        today={kathmanduToday()}
        kinds={[firstKind, ...otherKinds]}
        lines={lines}
        cancelHref={back}
        reloadHref={`/procurement/receipts/new?po=${po}`}
      />
    </Page>
  );
}
