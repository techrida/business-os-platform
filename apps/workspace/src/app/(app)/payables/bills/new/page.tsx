import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { isGuid } from '@/components/p2/customers/format';
import { listTaxCodes } from '@/components/p2/quote-builder/api';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { listBillSubmissions, type BillSubmission } from '@/lib/api-payables';
import { getPoProgress, type PoProgress } from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';

import { qtyText } from '../../../procurement/orders/_lib/model';
import { BillEntryForm, type OrderLine } from '../../_components/bill-entry-form';
import { billFailure } from '../../_lib/failure';
import { billGrants, fileStatusLabel } from '../../_lib/model';
import styles from '../../payables.module.css';

export const metadata: Metadata = { title: 'New bill · Business OS' };
export const dynamic = 'force-dynamic';

const INBOX = '/payables/inbox';

function Shell({ children }: { children: ReactNode }) {
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Inbox', href: INBOX }, { label: 'New bill' }]} />
      <PageHeader
        title="New bill"
        description="Key in a vendor's invoice from the inbox. The header comes from the vendor's submission; you enter the lines."
      />
      {children}
    </Page>
  );
}

export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<{ submission?: string | string[]; po?: string | string[] }>;
}) {
  const params = await searchParams;
  const submissionId = typeof params.submission === 'string' ? params.submission.trim() : '';
  const here = `/payables/bills/new${submissionId !== '' ? `?submission=${submissionId}` : ''}`;
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

  // A bill is keyed from a vendor submission: the invoice file is the submission's.
  if (!isGuid(submissionId)) {
    return (
      <Shell>
        <EmptyState
          title="Start from a vendor submission."
          icon="file-text"
          action={<LinkButton href={INBOX}>Open the inbox</LinkButton>}
        >
          A bill needs the vendor&apos;s invoice file. Pick a submission in the inbox and choose
          Create bill. Entering a bill without a submission is not available yet.
        </EmptyState>
      </Shell>
    );
  }

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
  try {
    taxCodes = (await listTaxCodes(session)).map((t) => ({ id: t.id, label: t.label }));
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
          <Panel title="Lines">
            <BillEntryForm
              submissionId={submission.id}
              // One key per render of this page: a double click or a retry creates the bill once.
              idempotencyKey={randomUUID()}
              orderLines={orderLines}
              taxCodes={taxCodes}
              cancelHref={INBOX}
              reloadHref={here}
            />
          </Panel>
        )}
      </div>
    </Shell>
  );
}
