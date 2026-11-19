import type { InvoiceDetail, TaxCode } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { getInvoice } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { InvoiceKindBadge, InvoiceStatusBadge } from '../_components/badges';
import { DayValue, Lines, NprSnapshot, Totals } from '../_components/detail-parts';
import { InvoiceActions } from '../_components/invoice-actions';
import { InvoicePreview } from '../_components/invoice-preview';
import { InvoiceProgress } from '../_components/invoice-progress';
import styles from '../_components/invoice.module.css';
import { InvoiceNoteActions } from '../_components/notes/note-actions';
import { invoiceGates } from '../_lib/gates';
import { approvalWords, kindMeta } from '../_lib/meta';

export const metadata: Metadata = { title: 'Invoice · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pdfAvailability(invoice: InvoiceDetail['invoice']) {
  if (invoice.kind === 'proforma') return 'A proforma has no PDF here.';
  if (invoice.status === 'discarded') return 'A discarded invoice has no PDF.';
  return 'The PDF is made when the invoice is issued.';
}

function facts(invoice: InvoiceDetail['invoice'], customerName: string | undefined): Fact[] {
  const out: Fact[] = [
    {
      key: 'number',
      label: 'Number',
      value:
        invoice.number !== null ? (
          <span className={styles.wrap}>{invoice.number}</span>
        ) : (
          <span className={styles.quiet}>Not numbered yet</span>
        ),
    },
    {
      key: 'issued',
      label: 'Issue date',
      value:
        invoice.issueDate !== null ? (
          <>
            <DayValue iso={invoice.issueDate} />
            {invoice.issueDateBs !== null ? ` (${invoice.issueDateBs} BS)` : ''}
          </>
        ) : (
          <span className={styles.quiet}>Set when the invoice is issued</span>
        ),
    },
    {
      key: 'due',
      label: 'Due date',
      value:
        invoice.dueDate !== null ? (
          <DayValue iso={invoice.dueDate} />
        ) : (
          <span className={styles.quiet}>None</span>
        ),
    },
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
    { key: 'currency', label: 'Currency', value: invoice.currency },
  );
  if (invoice.status !== 'issued' || invoice.kind === 'proforma') {
    out.push({ key: 'pdf', label: 'PDF', value: pdfAvailability(invoice) });
  }
  if (invoice.buyer?.address) {
    out.push({ key: 'billingAddress', label: 'Billing address', value: invoice.buyer.address });
  }
  if (invoice.buyer?.panVatNo) {
    out.push({
      key: 'buyerTaxNumber',
      label: 'Customer tax number',
      value: invoice.buyer.panVatNo,
    });
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
  // Issued: the buyer as frozen at issue. A draft has no snapshot yet, so the API sends the customer's current name.
  const customerName = invoice.buyer?.legalName ?? detail.customerName;
  const gates = invoiceGates(invoice, session.roles);
  const pdfNumber =
    invoice.kind !== 'proforma' && invoice.status === 'issued' ? invoice.number : null;
  const kind = kindMeta(invoice.kind).label;
  // Only a debit note needs the tax codes, and only the people who may write one are shown the button.
  // A list that fails to load degrades the dialog (it says so); it never fails the page.
  const taxCodes: TaxCode[] | null = gates.notes
    ? await listTaxCodes(session).catch((): null => null)
    : null;

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
          </>
        }
        description={customerName}
        actions={
          pdfNumber || gates.submit || gates.issue || gates.discard ? (
            <>
              <InvoiceActions invoice={invoice} gates={gates} reloadHref={path} />
              {pdfNumber ? (
                <InvoicePreview documentUrl={`${path}/document`} number={pdfNumber} />
              ) : null}
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
          <Panel title="Invoice details" description={`Last changed ${when(invoice.updatedAt)}`}>
            <FactList facts={facts(invoice, customerName)} />
          </Panel>
          <Lines detail={detail} />
        </div>
        <div className={styles.side}>
          <Totals invoice={invoice} />
          <NprSnapshot invoice={invoice} />
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
