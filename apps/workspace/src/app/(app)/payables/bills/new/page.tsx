import Link from 'next/link';
import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import type { ExpenseAccount } from '@bos/contracts';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { isGuid } from '@/components/p2/customers/format';
import { listExpenseAccounts } from '@/lib/api-company-accounts';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { listWithholdingCodes } from '@/lib/api-withholding-codes';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { listBillSubmissions, type BillSubmission } from '@/lib/api-payables';
import { listBillableOrders, ORDER_PICKER_LIMIT } from '@/lib/api-payables-orders';
import { getPoProgress, type PoProgress } from '@/lib/api-purchase-orders';
import { listVendors } from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import type { Session } from '@/lib/session';
import { getGrants, hasGrant } from '@/lib/grants';
import { when } from '@/lib/kernel-format';

import { PO_STATUS_LABEL, qtyText } from '../../../procurement/orders/_lib/model';
import { BillEntryForm, type OrderLine } from '../../_components/bill-entry-form';
import { amountText, duplicateText } from '../../_lib/duplicates';
import { billFailure } from '../../_lib/failure';
import { NEW_BILL_HEADING, withholdingOption } from '../../_lib/forms';
import { fileStatusLabel } from '../../_lib/model';
import { vendorOption } from '../../_lib/vendor-options';
import styles from '../../payables.module.css';

export const metadata: Metadata = { title: 'New bill · Business OS' };
export const dynamic = 'force-dynamic';

const INBOX = '/payables/inbox';

/**
 * The page frame. A bill keyed from an inbox submission names the inbox in the trail. When the entry form is on
 * screen it draws the heading itself, because the heading carries the form's Cancel and Create bill.
 */
function Shell({
  children,
  fromInbox = false,
  heading = true,
}: {
  children: ReactNode;
  fromInbox?: boolean;
  heading?: boolean;
}) {
  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Bills', href: '/payables/bills' },
          ...(fromInbox ? [{ label: 'Inbox', href: INBOX }] : []),
          { label: 'New bill' },
        ]}
      />
      {heading ? (
        <PageHeader title={NEW_BILL_HEADING.title} description={NEW_BILL_HEADING.description} />
      ) : null}
      {children}
    </Page>
  );
}

type AccountsLoad =
  { ok: true; accounts: ExpenseAccount[] } | { ok: false; forbidden: boolean; message: string };

/**
 * The expense accounts the line pickers offer. Retired ones come too, so a value already on a row keeps its
 * label; the picker offers active ones only. A refusal is worded for the accounts, not for bills.
 */
async function loadExpenseAccounts(session: Session): Promise<AccountsLoad> {
  try {
    return { ok: true, accounts: await listExpenseAccounts(session, { includeRetired: true }) };
  } catch (err) {
    const f = billFailure(err, 'load');
    return f.status === 403
      ? {
          ok: false,
          forbidden: true,
          message:
            "Your roles cannot read this company's expense accounts, and every bill line is booked to one. Ask an administrator for access.",
        }
      : { ok: false, forbidden: false, message: f.message };
  }
}

function AccountsProblem({ load, here }: { load: AccountsLoad & { ok: false }; here: string }) {
  return (
    <Alert
      tone={load.forbidden ? 'info' : 'error'}
      role="alert"
      title="The expense accounts did not load"
      actions={load.forbidden ? null : <a href={here}>Try again</a>}
    >
      {load.message}
    </Alert>
  );
}

export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<{
    submission?: string | string[];
    po?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const submissionId = typeof params.submission === 'string' ? params.submission.trim() : '';
  const poId = typeof params.po === 'string' ? params.po.trim() : '';
  const query = new URLSearchParams(
    submissionId !== '' ? { submission: submissionId } : poId !== '' ? { po: poId } : {},
  );
  const here = `/payables/bills/new${query.size > 0 ? `?${query}` : ''}`;
  const session = await requireStaffSession(here);

  // The caller's live grants, as the "Enter bill" links that lead here are decided (not the role defaults).
  const live = await getGrants(session);
  if (!hasGrant(live, 'payables.bill.enter')) {
    return (
      <Shell>
        <Alert tone="info" role="status" title="You cannot key in bills">
          Bills are keyed in by the accountants. Ask an administrator if you need that role.
        </Alert>
      </Shell>
    );
  }
  // The same grants the Settings menu shows Bank and expense accounts for.
  const canManageAccounts =
    hasGrant(live, 'settings.finance.write') || hasGrant(live, 'admin.settings.write');

  if (submissionId === '') {
    if (params.po !== undefined && !isGuid(poId))
      return (
        <Shell>
          <Alert
            tone="warning"
            role="alert"
            actions={<Link href="/payables/bills/new">Start a new bill</Link>}
          >
            That link does not name a valid purchase order. Start a new bill, choose the vendor, and
            pick the order from the vendor&apos;s purchase orders.
          </Alert>
        </Shell>
      );
    let standaloneOrder: PoProgress | undefined;
    let vendors: { id: string; name: string; description?: string }[] = [];
    let vendorCount = 0;
    let standaloneTax: { id: string; label: string }[];
    let standaloneWithholding: { id: string; label: string }[];
    // The order picker is a help, not a requirement: a failure leaves the bill without an order.
    let orders: { id: string; vendorId: string; label: string }[] = [];
    let ordersProblem = false;
    if (poId === '') {
      try {
        orders = (await listBillableOrders(session)).map((o) => ({
          id: o.id,
          vendorId: o.vendorId,
          label: `${o.number} · ${PO_STATUS_LABEL[o.status].text}`,
        }));
      } catch {
        ordersProblem = true;
      }
    }
    try {
      if (poId !== '') {
        standaloneOrder = await getPoProgress(session, poId);
      } else {
        const result = await listVendors(session, { limit: 100, offset: 0 });
        vendors = result.items.map((vendor) => {
          const option = vendorOption(vendor);
          return {
            id: option.id,
            name: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          };
        });
        vendorCount = result.total;
      }
      standaloneTax = (await listTaxCodes(session)).map((tax) => ({
        id: tax.id,
        label: tax.label,
      }));
      standaloneWithholding = (await listWithholdingCodes(session)).map(withholdingOption);
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
    const accounts = await loadExpenseAccounts(session);
    if (!accounts.ok)
      return (
        <Shell>
          <AccountsProblem load={accounts} here={here} />
        </Shell>
      );
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
    // The vendor picker is part of the entry form: typing searches the vendors, no separate search step.
    const lookup = (
      <>
        {ordersProblem ? (
          <p className={styles.note}>
            The vendors&apos; purchase orders did not load, so this bill can only be entered without
            one. Reload the page to try again.
          </p>
        ) : orders.length >= ORDER_PICKER_LIMIT ? (
          <p className={styles.note}>
            Showing the newest {ORDER_PICKER_LIMIT} purchase orders that can be billed.
          </p>
        ) : null}
      </>
    );
    if (poId === '' && vendors.length === 0)
      return (
        <Shell>
          {lookup}
          <Alert tone="info" role="status">
            There are no vendors to bill yet. Ask Procurement to add the vendor.
          </Alert>
        </Shell>
      );
    return (
      <Shell heading={false}>
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
          expenseAccounts={accounts.accounts}
          canManageAccounts={canManageAccounts}
          cancelHref="/payables/bills"
          reloadHref={here}
          entry={{
            vendors,
            // More vendors than the page lists: the picker asks the server as the user types.
            searchVendors: vendorCount > 100,
            orders,
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
        >
          {lookup}
        </BillEntryForm>
      </Shell>
    );
  }
  if (!isGuid(submissionId))
    return (
      <Shell fromInbox>
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
      <Shell fromInbox>
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
      <Shell fromInbox>
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
    withholdingCodes = (await listWithholdingCodes(session)).map(withholdingOption);
    if (taxCodes.length === 0) taxProblem = 'No VAT codes are set up yet. Ask an administrator.';
  } catch (err) {
    taxProblem = billFailure(err, 'load').message;
  }

  const accounts = await loadExpenseAccounts(session);

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
          : (orderProblem ?? taxProblem ?? (accounts.ok ? undefined : accounts.message));

  const fromSubmission = (
    <>
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
    </>
  );

  if (blocked !== undefined)
    return (
      <Shell fromInbox>
        {fromSubmission}
        <Alert
          tone="warning"
          role="alert"
          title="This bill cannot be keyed in yet"
          actions={<a href={here}>Reload</a>}
        >
          {blocked}
        </Alert>
      </Shell>
    );
  return (
    <Shell fromInbox heading={false}>
      <BillEntryForm
        submissionId={submission.id}
        // One key per render of this page: a double click or a retry creates the bill once.
        idempotencyKey={randomUUID()}
        orderLines={orderLines}
        taxCodes={taxCodes}
        withholdingCodes={withholdingCodes}
        expenseAccounts={accounts.ok ? accounts.accounts : []}
        canManageAccounts={canManageAccounts}
        cancelHref={INBOX}
        reloadHref={here}
      >
        {fromSubmission}
      </BillEntryForm>
    </Shell>
  );
}
