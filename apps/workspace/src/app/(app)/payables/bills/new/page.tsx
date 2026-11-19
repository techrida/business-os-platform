import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { todayInKathmandu } from '@/app/(app)/admin/format';
import { isGuid } from '@/components/p2/customers/format';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { listWithholdingCodes } from '@/lib/api-withholding-codes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { listBillSubmissions, type BillSubmission } from '@/lib/api-payables';
import { getPoProgress, type PoProgress } from '@/lib/api-purchase-orders';
import { listVendors } from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { qtyText } from '../../../procurement/orders/_lib/model';
import { BillEntryForm, type OrderLine } from '../../_components/bill-entry-form';
import { amountText, duplicateText } from '../../_lib/duplicates';
import { billFailure } from '../../_lib/failure';
import { billGrants, fileStatusLabel } from '../../_lib/model';
import styles from '../../payables.module.css';

export const metadata: Metadata = { title: 'New bill · Business OS' };
export const dynamic = 'force-dynamic';

const INBOX = '/payables/inbox';

function Shell({ children }: { children: ReactNode }) {
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Inbox', href: INBOX }, { label: 'New bill' }]} />
      <PageHeader
        title="New bill"
        description="Key in a vendor's invoice, or start from an invoice in the inbox. The platform calculates VAT, withholding and totals from the lines."
      />
      {children}
    </Page>
  );
}

export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<{
    submission?: string | string[];
    po?: string | string[];
    q?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const submissionId = typeof params.submission === 'string' ? params.submission.trim() : '';
  const poId = typeof params.po === 'string' ? params.po.trim() : '';
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 200) : '';
  const query = new URLSearchParams(
    submissionId !== ''
      ? { submission: submissionId }
      : poId !== ''
        ? { po: poId }
        : q !== ''
          ? { q }
          : {},
  );
  const here = `/payables/bills/new${query.size > 0 ? `?${query}` : ''}`;
  const session = await requireStaffSession(here);

  if (!billGrants(session.roles).enter) {
    return (
      <Shell>
        <Alert tone="info" role="status" title="You cannot key in bills">
          Bills are keyed in by the accountants. Ask an administrator if you need that role.
        </Alert>
      </Shell>
    );
  }

  if (submissionId === '') {
    if (params.po !== undefined && !isGuid(poId))
      return (
        <Shell>
          <Alert tone="warning" role="alert">
            That is not a valid purchase order. Open the order again and choose Enter bill.
          </Alert>
        </Shell>
      );
    let standaloneOrder: PoProgress | undefined;
    let vendors: { id: string; name: string }[] = [];
    let vendorCount = 0;
    let standaloneTax: { id: string; label: string }[];
    let standaloneWithholding: { id: string; label: string }[];
    try {
      if (poId !== '') {
        standaloneOrder = await getPoProgress(session, poId);
      } else {
        const result = await listVendors(session, {
          limit: 100,
          offset: 0,
          ...(q === '' ? {} : { q }),
        });
        vendors = result.items.map((vendor) => ({ id: vendor.id, name: vendor.legalName }));
        vendorCount = result.total;
      }
      standaloneTax = (await listTaxCodes(session)).map((tax) => ({
        id: tax.id,
        label: tax.label,
      }));
      standaloneWithholding = (await listWithholdingCodes(session)).map((code) => ({
        id: code.id,
        label: `${code.code} - ${code.name}`,
      }));
    } catch (err) {
      return (
        <Shell>
          <Alert
            tone="error"
            role="alert"
            title="The bill details did not load"
            actions={<a href={here}>Try again</a>}
          >
            {billFailure(err, 'load').message}
          </Alert>
        </Shell>
      );
    }
    if (
      standaloneOrder &&
      !['issued', 'partially_received', 'fully_received'].includes(standaloneOrder.status)
    )
      return (
        <Shell>
          <Alert tone="warning" role="alert">
            This purchase order cannot be billed in its current status.
          </Alert>
        </Shell>
      );
    if (standaloneTax.length === 0)
      return (
        <Shell>
          <Alert tone="warning" role="alert">
            No VAT codes are set up yet. Ask an administrator before entering a bill.
          </Alert>
        </Shell>
      );
    return (
      <Shell>
        {poId === '' ? (
          <form method="get" action="/payables/bills/new" className={styles.filter}>
            <Field label="Find a vendor">
              {(control) => (
                <SearchInput placeholder="Vendor name" name="q" defaultValue={q} {...control} />
              )}
            </Field>
            <Button type="submit" variant="secondary">
              Find vendor
            </Button>
          </form>
        ) : null}
        {vendorCount > 100 ? (
          <p className={styles.note}>
            Showing the first 100 vendors. Search by name to narrow the list.
          </p>
        ) : null}
        {poId === '' && vendors.length === 0 ? (
          <Alert tone="info" role="status">
            No vendors match this search. Try another name, or ask Procurement to add the vendor.
          </Alert>
        ) : (
          <BillEntryForm
            invoiceTitle={
              standaloneOrder ? `Invoice for ${standaloneOrder.number}` : 'Vendor invoice'
            }
            idempotencyKey={randomUUID()}
            orderLines={
              standaloneOrder?.lines.map((line) => ({
                poLineId: line.poLineId,
                lineNo: line.lineNo,
                description: line.description,
                uom: line.uom,
                open: qtyText(line.openQuantity),
              })) ?? []
            }
            taxCodes={standaloneTax}
            withholdingCodes={standaloneWithholding}
            cancelHref="/payables/bills"
            reloadHref={here}
            entry={{
              vendors,
              // The invoice date starts at today in Kathmandu (the tenant's calendar), and stays editable.
              today: todayInKathmandu(),
              ...(standaloneOrder
                ? {
                    vendorPartyId: standaloneOrder.vendorId,
                    vendorName: standaloneOrder.vendorName,
                    purchaseOrderId: standaloneOrder.purchaseOrderId,
                  }
                : {}),
            }}
          />
        )}
      </Shell>
    );
  }
  if (!isGuid(submissionId))
    return (
      <Shell>
        <Alert tone="warning" role="alert">
          That is not a valid submission. Open the inbox again.
        </Alert>
      </Shell>
    );

  let submission: BillSubmission | undefined;
  try {
    submission = (await listBillSubmissions(session)).find((s) => s.id === submissionId);
  } catch (err) {
    const f = billFailure(err, 'load');
    return (
      <Shell>
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title="The inbox did not load"
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Shell>
    );
  }
  // The inbox lists only received submissions: a missing one was converted, rejected or is another entity's.
  if (submission === undefined) {
    return (
      <Shell>
        <EmptyState
          title="That submission is not waiting any more."
          icon="check-circle"
          action={<LinkButton href={INBOX}>Back to the inbox</LinkButton>}
        >
          It may have been turned into a bill or rejected already, or it belongs to another legal
          entity.
        </EmptyState>
      </Shell>
    );
  }

  const file = fileStatusLabel(submission.fileStatus);
  let order: PoProgress | undefined;
  let orderProblem: string | undefined;
  if (submission.purchaseOrderId !== null) {
    try {
      order = await getPoProgress(session, submission.purchaseOrderId);
    } catch (err) {
      orderProblem = billFailure(err, 'load').message;
    }
  }
  let taxProblem: string | undefined;
  let taxCodes: { id: string; label: string }[] = [];
  let withholdingCodes: { id: string; label: string }[] = [];
  try {
    taxCodes = (await listTaxCodes(session)).map((t) => ({ id: t.id, label: t.label }));
    withholdingCodes = (await listWithholdingCodes(session)).map((code) => ({
      id: code.id,
      label: `${code.code} - ${code.name}`,
    }));
    if (taxCodes.length === 0) taxProblem = 'No VAT codes are set up yet. Ask an administrator.';
  } catch (err) {
    taxProblem = billFailure(err, 'load').message;
  }

  const facts: Fact[] = [
    {
      key: 'vendor',
      label: 'Vendor',
      value: submission.vendorName ?? <span className={styles.quiet}>Not named</span>,
    },
    {
      key: 'invoice',
      label: 'Vendor invoice',
      value: <span className={styles.long}>{submission.vendorInvoiceNo ?? 'Missing'}</span>,
    },
    {
      key: 'date',
      label: 'Invoice date',
      value:
        submission.invoiceDate !== null ? (
          <time dateTime={submission.invoiceDate}>{when(submission.invoiceDate, 'date')}</time>
        ) : (
          'Missing'
        ),
    },
    {
      key: 'claimed',
      label: 'Amount the vendor claimed',
      value: amountText(submission.claimedTotal, submission.currency) ?? (
        <span className={styles.quiet}>Not given</span>
      ),
    },
    {
      key: 'po',
      label: 'Purchase order',
      value:
        submission.purchaseOrderId === null ? (
          <span className={styles.quiet}>None</span>
        ) : (
          (order?.number ?? 'An order')
        ),
    },
    { key: 'file', label: 'Invoice file', value: <Badge tone={file.tone}>{file.text}</Badge> },
  ];

  const orderLines: OrderLine[] =
    order?.lines.map((l) => ({
      poLineId: l.poLineId,
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      open: qtyText(l.openQuantity),
    })) ?? [];

  const blocked =
    submission.fileStatus !== 'clean'
      ? 'The vendor’s file has not passed its virus scan, so a bill cannot be made from it yet. Reload this page once the scan is done.'
      : submission.vendorPartyId === null
        ? 'The vendor did not name a vendor account. Reject this submission and ask for it again.'
        : submission.vendorInvoiceNo === null || submission.invoiceDate === null
          ? 'The invoice number or date is missing. Reject this submission and ask for it again.'
          : (orderProblem ?? taxProblem);

  return (
    <Shell>
      <div className={styles.stack}>
        <Panel title="From the submission">
          <FactList facts={facts} />
        </Panel>
        {submission.duplicates.length > 0 ? (
          <Alert tone="warning" title="Duplicate invoice number">
            This vendor already sent invoice {submission.vendorInvoiceNo}. Check it is not the same
            bill before you key it in:
            <ul>
              {submission.duplicates.map((d) => (
                <li key={d.id}>{duplicateText(d)}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        {blocked !== undefined ? (
          <Alert
            tone="warning"
            role="alert"
            title="This bill cannot be keyed in yet"
            actions={<a href={here}>Reload</a>}
          >
            {blocked}
          </Alert>
        ) : (
          <BillEntryForm
            submissionId={submission.id}
            // One key per render of this page: a double click or a retry creates the bill once.
            idempotencyKey={randomUUID()}
            orderLines={orderLines}
            taxCodes={taxCodes}
            withholdingCodes={withholdingCodes}
            cancelHref={INBOX}
            reloadHref={here}
          />
        )}
      </div>
    </Shell>
  );
}
