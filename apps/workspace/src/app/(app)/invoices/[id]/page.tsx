import type { InvoiceDetail, SettlementStatus } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { getInvoice } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { requireStaffSession } from '@/lib/bff';
import { getDisplaySettings } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { getPermissionCheck } from '@/lib/live-permissions';

import { InvoiceKindBadge, InvoiceStatusBadge } from '../_components/badges';
import { LineBreakdown, NprSnapshot } from '../_components/detail-parts';
import { documentContact, documentFormat } from '../_components/document/format';
import { InvoiceDocument } from '../_components/document/invoice-document';
import { InvoiceActions } from '../_components/invoice-actions';
import { InvoicePreview } from '../_components/invoice-preview';
import { InvoiceProgress } from '../_components/invoice-progress';
import styles from '../_components/invoice.module.css';
import { InvoiceNoteActions } from '../_components/notes/note-actions';
import { ApprovalHistory, loadApproval } from '../../payables/_components/approval-history';
import { PromiseCard } from '../_components/promise-card';
import { invoiceGates, recordPaymentHref } from '../_lib/gates';
import { approvalWords, kindMeta } from '../_lib/meta';
import { settlementMeta } from '../../receivables/_lib/settlement';
import { invoicePromisesOf } from './promises-api';

export const metadata: Metadata = { title: 'Invoice · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pdfAvailability(invoice: InvoiceDetail['invoice']) {
  if (invoice.kind === 'proforma') return 'A proforma has no PDF here.';
  if (invoice.status === 'discarded') return 'A discarded invoice has no PDF.';
  return 'The PDF is made when the invoice is issued.';
}

/**
 * The issued invoice's payment position, derived by the server from its allocations and credit notes (plan A8) and
 * sent on the detail itself, so whoever reads the invoice sees it without `ar.read`. Null for a draft, a proforma or a
 * credit note (they have no open item), or when an older API sent none: the rest of the page stands.
 */
function settlementOf(detail: InvoiceDetail): Settlement | null {
  const { settlement, openAmount } = detail;
  if (settlement == null || openAmount == null) return null;
  return { settlement, openAmount };
}

interface Settlement {
  settlement: SettlementStatus;
  openAmount: string;
}

function facts(
  invoice: InvoiceDetail['invoice'],
  customerName: string | undefined,
  settlement: Settlement | null,
  numberSystems: NumberSystems,
): Fact[] {
  const out: Fact[] = [
    ...(settlement !== null
      ? [
          {
            key: 'open',
            label: 'Open amount',
            value: money(settlement.openAmount, invoice.currency, numberSystems),
          },
        ]
      : []),
    {
      key: 'customer',
      label: 'Customer',
      value: (
        <Link href={`/customers/${encodeURIComponent(invoice.customerId)}`} className={styles.wrap}>
          {customerName ?? 'Customer details unavailable'}
        </Link>
      ),
    },
  ];
  if (invoice.salesOrderId !== null) {
    out.push({
      key: 'order',
      label: 'Sales order',
      value: (
        <Link href={`/sales-orders/${encodeURIComponent(invoice.salesOrderId)}`}>
          Open sales order
        </Link>
      ),
    });
  }
  if (invoice.originalInvoiceId !== null) {
    out.push({
      key: 'original',
      label: 'Corrects',
      value: (
        <Link href={`/invoices/${encodeURIComponent(invoice.originalInvoiceId)}`}>
          Open original invoice
        </Link>
      ),
    });
  }
  out.push(
    {
      key: 'approval',
      label: 'Approval',
      value: (
        <>
          {approvalWords(invoice.kind, invoice.status)}
          {invoice.approvalRequestId !== null && invoice.kind !== 'proforma' ? (
            <>
              {' '}
              <Link href={`/inbox/${encodeURIComponent(invoice.approvalRequestId)}`}>
                Open the approval request
              </Link>
            </>
          ) : null}
        </>
      ),
    },
    { key: 'fy', label: 'Fiscal year', value: invoice.fiscalYear ?? '—' },
  );
  if (invoice.status !== 'issued' || invoice.kind === 'proforma') {
    out.push({ key: 'pdf', label: 'PDF', value: pdfAvailability(invoice) });
  }
  if (invoice.manualReason !== null) {
    out.push({
      key: 'manual',
      label: 'Why it was raised without a sales order',
      value: <span className={styles.wrap}>{invoice.manualReason}</span>,
      wide: true,
    });
  }
  if (invoice.noteReason !== null) {
    out.push({
      key: 'note',
      label: 'Reason for the note',
      value: <span className={styles.wrap}>{invoice.noteReason}</span>,
      wide: true,
    });
  }
  return out;
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Not a UUID: no invoice can have this id, so there is nothing to ask the API.
  if (!UUID.test(id)) notFound();
  const path = `/invoices/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);
  const [display, can] = await Promise.all([getDisplaySettings(), getPermissionCheck(session)]);

  let detail: InvoiceDetail;
  try {
    detail = await getInvoice(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Invoices', href: '/invoices' }, { label: 'Invoice' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403 ? 'Your roles do not include invoices' : 'This invoice did not load'
          }
          actions={f.status !== 403 ? <Link href={path}>Try again</Link> : null}
        >
          {f.status === 403
            ? 'Invoices are for the accounts and finance teams and for management. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  const { invoice } = detail;
  // Numbers and dates as the first print drew them, so the screen matches every copy of the PDF; never printed,
  // today's settings.
  const format = documentFormat(detail.format, display);
  const { numberSystems } = format;
  // Issued: the buyer as frozen at issue. A draft has no snapshot yet, so the API sends the customer's current name.
  const customerName = invoice.buyer?.legalName ?? detail.customerName;
  const gates = invoiceGates(
    { ...invoice, can: detail.can },
    can,
    detail.issueBlockedBySod === true,
  );
  const pdfNumber =
    invoice.kind !== 'proforma' && invoice.status === 'issued' ? invoice.number : null;
  const kind = kindMeta(invoice.kind).label;
  // Only a debit note needs the tax codes, and only the people who may write one are shown the button.
  // A list that fails to load degrades the dialog (it says so); it never fails the page.
  const [taxCodes, approval, promises] = await Promise.all([
    gates.notes ? listTaxCodes(session).catch((): null => null) : Promise.resolve(null),
    // The approval's own read, as this person; a refused or failed read leaves the panel out.
    loadApproval(session, invoice.approvalRequestId),
    invoicePromisesOf(session, invoice, can),
  ]);
  const settlement = settlementOf(detail);
  const payment = settlement === null ? null : settlementMeta(settlement.settlement);
  // Only while something is still owed, as the server's settlement says; unknown settlement (null, never left out)
  // offers nothing.
  const recordPayment = recordPaymentHref(
    { ...invoice, can: detail.can },
    can,
    settlement === null ? null : settlement.settlement,
  );

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Invoices', href: '/invoices' }, { label: invoice.number ?? kind }]}
      />
      <PageHeader
        title={<span className={styles.wrap}>{invoice.number ?? kind}</span>}
        status={
          <>
            {invoice.number ? <InvoiceKindBadge kind={invoice.kind} /> : null}
            <InvoiceStatusBadge status={invoice.status} />
            {payment !== null ? <Badge tone={payment.tone}>{payment.label}</Badge> : null}
          </>
        }
        description={customerName}
        actions={
          pdfNumber ||
          gates.submit ||
          gates.issue ||
          gates.reopen ||
          gates.discard ||
          recordPayment ? (
            <>
              <InvoiceActions
                invoice={invoice}
                gates={gates}
                reloadHref={path}
                dateFormat={format.dateFormat}
              />
              {pdfNumber ? (
                <InvoicePreview
                  documentUrl={`${path}/document`}
                  number={pdfNumber}
                  // The API's Retry needs invoice.issue on this invoice: the grant, and its scope reaching it.
                  mayRetry={can('invoice.issue') && detail.can?.issue !== false}
                />
              ) : null}
              {recordPayment ? <LinkButton href={recordPayment}>Record payment</LinkButton> : null}
            </>
          ) : undefined
        }
      />

      <InvoiceProgress invoice={invoice} />

      {invoice.status === 'returned' ? (
        <Alert tone="info" title="This invoice was returned for changes.">
          The approvers sent it back. It stays out of the approval flow until it is submitted again.
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <div className={styles.detailMain}>
          <InvoiceDocument
            detail={detail}
            customerName={customerName}
            format={format}
            sellerContact={documentContact(detail.format, display.sellerContact)}
          />
        </div>
        <div className={styles.side}>
          <Panel
            as="aside"
            title={
              invoice.kind === 'debit_note'
                ? 'Debit note details'
                : invoice.kind === 'credit_note'
                  ? 'Credit note details'
                  : 'Invoice details'
            }
            description={`Last changed ${when(invoice.updatedAt, 'datetime', format.dateFormat)}`}
          >
            <FactList facts={facts(invoice, customerName, settlement, numberSystems)} />
          </Panel>
          <NprSnapshot
            invoice={invoice}
            numberSystems={numberSystems}
            dateFormat={format.dateFormat}
          />
          <LineBreakdown detail={detail} numberSystems={numberSystems} />
          {/* A draft sent back to draft keeps its earlier request id; its history would read as an approval it no longer has. */}
          {approval !== null && invoice.status !== 'draft' ? (
            <ApprovalHistory approval={approval} />
          ) : null}
          {promises ? (
            <PromiseCard
              invoiceId={invoice.id}
              promises={promises}
              dateFormat={format.dateFormat}
              reloadHref={path}
            />
          ) : null}
          {gates.notes ? (
            <Panel as="aside" title="Adjustments">
              <div className={styles.noteSlot} data-slot="invoice-note-actions">
                <InvoiceNoteActions
                  invoice={invoice}
                  lines={detail.lines}
                  taxCodes={taxCodes}
                  gates={gates}
                />
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
