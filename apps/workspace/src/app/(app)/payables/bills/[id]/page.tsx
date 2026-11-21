import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ExpenseAccount } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { SuccessNotice } from '@/components/p4/success-notice';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listExpenseAccounts } from '@/lib/api-company-accounts';
import { getBill, type VendorBill } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { getGrants, hasGrant } from '@/lib/grants';
import { accountLabel } from '@/lib/company-account-options';
import { when } from '@/lib/kernel-format';

import { poGrants, poMoney, qtyText } from '../../../procurement/orders/_lib/model';
import {
  ExceptionDialog,
  MatchDialog,
  SubmitDialog,
  DiscardBillDialog,
  VoidDialog,
} from '../../_components/bill-actions';
import { ApprovalHistory, loadApproval } from '../../_components/approval-history';
import { InvoiceReplacement } from '../../_components/invoice-replacement';
import { billFailure } from '../../_lib/failure';
import {
  BILL_STATUS_LABEL,
  MATCH_STATUS_LABEL,
  billActions,
  fileStatusLabel,
  matchResultLabel,
  type BillGrants,
} from '../../_lib/model';
import styles from '../../payables.module.css';

export const metadata: Metadata = { title: 'Bill · Business OS' };
export const dynamic = 'force-dynamic';

function Lines({
  bill,
  numberSystems,
  accounts,
}: {
  bill: VendorBill;
  numberSystems: NumberSystems;
  /** Every expense account, retired ones included; null when they did not load. */
  accounts: readonly ExpenseAccount[] | null;
}) {
  return (
    <Panel
      title="Lines"
      description="As keyed in from the vendor's invoice. The net, VAT and withholding are the platform's, not typed."
    >
      {accounts === null ? (
        <p className={styles.note}>
          The expense accounts did not load, so the account names are not shown. Reload the page to
          try again.
        </p>
      ) : null}
      <Table caption="Bill lines" minWidth={1040}>
        <thead>
          <tr>
            <Th align="end">#</Th>
            <Th>Item</Th>
            <Th>Expense account</Th>
            <Th align="end">Quantity</Th>
            <Th align="end">Unit price</Th>
            <Th align="end">Net</Th>
            <Th align="end">VAT</Th>
            <Th align="end">Withholding</Th>
          </tr>
        </thead>
        <tbody>
          {bill.lines.map((l) => (
            <tr key={l.id}>
              <Td align="end" nowrap>
                {l.lineNo}
              </Td>
              <Td>
                <span className={styles.long}>{l.description}</span>
              </Td>
              <Td>
                {accounts === null ? (
                  <span className={styles.quiet}>Not loaded</span>
                ) : (
                  <span className={styles.long}>
                    {accountLabel('expense', l.accountId, accounts)}
                  </span>
                )}
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>{qtyText(l.quantity)}</span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>
                  {poMoney(l.unitPrice, bill.currency, numberSystems)}
                </span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>
                  {poMoney(l.netAmount, bill.currency, numberSystems)}
                </span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>
                  {poMoney(l.vatAmount, bill.currency, numberSystems)}
                </span>
              </Td>
              <Td align="end" nowrap>
                <span className={styles.numeric}>
                  {poMoney(l.tdsAmount, bill.currency, numberSystems)}
                </span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Panel>
  );
}

function MatchPanel({ bill, numberSystems }: { bill: VendorBill; numberSystems: NumberSystems }) {
  if (bill.purchaseOrderId === null) {
    return (
      <Panel title="Match">
        <p className={styles.note}>
          This bill names no purchase order, so there is nothing to match it against. It goes to
          approval as it is.
        </p>
      </Panel>
    );
  }
  const matched = bill.lines.filter((l) => l.match !== null);
  return (
    <Panel
      title="Match against the order and receipts"
      description="What the invoice bills, compared with what was ordered and received. Variances are as the platform worked them out."
    >
      {matched.length === 0 ? (
        <p className={styles.note}>
          This bill has not been matched yet. Match it to see the result.
        </p>
      ) : (
        <Table caption="Match result by bill line" minWidth={900}>
          <thead>
            <tr>
              <Th align="end">#</Th>
              <Th>Item</Th>
              <Th align="end">Billed</Th>
              <Th align="end">Received</Th>
              <Th align="end">Quantity variance</Th>
              <Th align="end">Price variance</Th>
              <Th align="end">VAT variance</Th>
              <Th>Result</Th>
            </tr>
          </thead>
          <tbody>
            {matched.map((l) => {
              const m = l.match;
              if (m === null) return null;
              const result = matchResultLabel(m.status);
              return (
                <tr key={l.id}>
                  <Td align="end" nowrap>
                    {l.lineNo}
                  </Td>
                  <Td>
                    <span className={styles.long}>{l.description}</span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>{qtyText(m.billedQuantity)}</span>
                  </Td>
                  <Td align="end" nowrap>
                    {m.receivedQuantity !== null ? (
                      <span className={styles.numeric}>{qtyText(m.receivedQuantity)}</span>
                    ) : (
                      <span className={styles.quiet}>Nothing received</span>
                    )}
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>{qtyText(m.quantityVariance)}</span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>
                      {poMoney(m.priceVariance, bill.currency, numberSystems)}
                    </span>
                  </Td>
                  <Td align="end" nowrap>
                    <span className={styles.numeric}>
                      {poMoney(m.taxVariance, bill.currency, numberSystems)}
                    </span>
                  </Td>
                  <Td nowrap>
                    <Badge tone={result.tone}>{result.text}</Badge>
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

export default async function BillPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ created?: string | string[] }>;
}) {
  const { id } = await params;
  // An id that is not a GUID cannot be a bill, so it never reaches the API.
  if (!isGuid(id)) notFound();
  const justCreated = searchParams !== undefined && (await searchParams).created === '1';
  const here = `/payables/bills/${id}`;
  const session = await requireStaffSession(here);
  const numberSystems = await getNumberSystems();

  let bill: VendorBill;
  try {
    bill = await getBill(session, id);
  } catch (err) {
    const f = billFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Bills', href: '/payables/bills' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this bill' : 'This bill did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  // Both names come with the bill, under the bill's own read: no vendor or order read is needed.
  const vendorName = bill.vendorName;
  const orderNumber = bill.purchaseOrderNumber ?? undefined;

  const approval = await loadApproval(session, bill.approvalRequestId);
  // Retired accounts too, so a line booked to one keeps its name. A failed read leaves the bill on screen.
  const accounts = await listExpenseAccounts(session, { includeRetired: true }).catch(() => null);
  // Live grants (GET /v1/me), not the role defaults: the actions and the order link show for whoever an admin
  // granted them, and hide for a role whose grant was removed. The API still checks the bill itself.
  const live = await getGrants(session);
  const grants: BillGrants = {
    enter: hasGrant(live, 'payables.bill.enter'),
    read: hasGrant(live, 'payables.bill.read'),
  };
  const can = billActions(bill, grants);
  const status = BILL_STATUS_LABEL[bill.status];
  const match = MATCH_STATUS_LABEL[bill.matchStatus];
  const common = {
    targetId: bill.id,
    label: bill.number ?? `invoice ${bill.vendorInvoiceNo}`,
    reloadHref: here,
  };
  const canDiscard = bill.status === 'draft' && grants.enter && bill.can?.discard !== false;
  const inVariance = bill.status === 'variance' || bill.matchStatus === 'variance';
  const canException =
    grants.enter &&
    bill.can?.exception !== false &&
    bill.status === 'variance' &&
    bill.matchStatus === 'variance';

  const facts: Fact[] = [
    {
      key: 'vendor',
      label: 'Vendor',
      // The vendor page needs vendor.read; without it the name is plain text, not a link to a refusal.
      value: hasGrant(live, 'vendor.read') ? (
        <Link href={`/vendors/${encodeURIComponent(bill.vendorPartyId)}`} className={styles.long}>
          {vendorName ?? 'Open the vendor'}
        </Link>
      ) : (
        <span className={styles.long}>{vendorName ?? 'Not recorded'}</span>
      ),
    },
    {
      key: 'invoice',
      label: 'Vendor invoice',
      value: <span className={styles.long}>{bill.vendorInvoiceNo}</span>,
    },
    {
      key: 'date',
      label: 'Invoice date',
      value: <time dateTime={bill.invoiceDate}>{when(bill.invoiceDate, 'date')}</time>,
    },
    { key: 'fy', label: 'Fiscal year', value: bill.fiscalYear },
    {
      key: 'po',
      label: 'Purchase order',
      value:
        bill.purchaseOrderId === null ? (
          <span className={styles.quiet}>None</span>
        ) : poGrants(live).read ? (
          <Link href={`/procurement/orders/${encodeURIComponent(bill.purchaseOrderId)}`}>
            {orderNumber ?? 'Open the order'}
          </Link>
        ) : (
          (orderNumber ?? 'An order')
        ),
    },
    { key: 'match', label: 'Match', value: <Badge tone={match.tone}>{match.text}</Badge> },
    {
      key: 'approval',
      label: 'Approval',
      value:
        bill.approvalRequestId !== null ? (
          <Link href={`/inbox/${encodeURIComponent(bill.approvalRequestId)}`}>
            See the approval request
          </Link>
        ) : (
          <span className={styles.quiet}>Not submitted yet</span>
        ),
    },
  ];
  const totals: Fact[] = [
    { key: 'net', label: 'Net', value: poMoney(bill.netTotal, bill.currency, numberSystems) },
    { key: 'vat', label: 'VAT', value: poMoney(bill.vatTotal, bill.currency, numberSystems) },
    {
      key: 'tds',
      label: 'Withholding',
      value: poMoney(bill.tdsTotal, bill.currency, numberSystems),
    },
    {
      key: 'payable',
      label: 'Payable',
      value: <strong>{poMoney(bill.payableTotal, bill.currency, numberSystems)}</strong>,
    },
  ];

  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Bills', href: '/payables/bills' },
          { label: bill.number ?? 'Draft bill' },
        ]}
      />
      <PageHeader
        title={
          <span className={styles.long}>{bill.number ?? `Invoice ${bill.vendorInvoiceNo}`}</span>
        }
        status={<Badge tone={status.tone}>{status.text}</Badge>}
        description={
          bill.kind === 'vendor_credit_note'
            ? 'A credit note from the vendor.'
            : 'A vendor invoice, matched before it goes for approval.'
        }
        actions={
          can.match || can.submit || can.void || canException || canDiscard ? (
            <div className={styles.headActions}>
              {can.match ? <MatchDialog {...common} idempotencyKey={randomUUID()} /> : null}
              {can.submit ? <SubmitDialog {...common} idempotencyKey={randomUUID()} /> : null}
              {canException ? <ExceptionDialog {...common} idempotencyKey={randomUUID()} /> : null}
              {can.void ? <VoidDialog {...common} idempotencyKey={randomUUID()} /> : null}
              {canDiscard ? <DiscardBillDialog {...common} idempotencyKey={randomUUID()} /> : null}
            </div>
          ) : null
        }
      />

      <div className={styles.stack}>
        {justCreated ? <SuccessNotice message="The bill was created." /> : null}
        {inVariance ? (
          <Alert tone="warning" role="status" title="This bill is outside the tolerance">
            It cannot be submitted for approval while a line is outside the tolerance. Match it
            again after goods arrive or the order changes, or request an exception for Finance to
            review.
          </Alert>
        ) : null}
        {bill.status === 'draft' && bill.fileStatus !== 'clean' ? (
          <Panel title="Invoice file" description={fileStatusLabel(bill.fileStatus ?? null).text}>
            <p className={styles.note}>
              The invoice must scan clean before this bill can be submitted. If a scan is in
              progress, wait and reload the bill to check it.
            </p>
            {canDiscard ? (
              <InvoiceReplacement documentId={bill.documentId} reloadHref={here} />
            ) : null}
          </Panel>
        ) : null}
        <div className={styles.columns}>
          <div className={styles.stack}>
            <Panel title="Bill">
              <FactList facts={facts} />
            </Panel>
          </div>
          <aside className={styles.stack}>
            <Panel title="Totals" description="Worked out by the platform from the lines.">
              <FactList facts={totals} />
            </Panel>
            {approval !== null ? <ApprovalHistory approval={approval} /> : null}
          </aside>
        </div>
        {/* The line tables run the full width: seven or eight columns do not fit beside the totals. */}
        <Lines numberSystems={numberSystems} bill={bill} accounts={accounts} />
        <MatchPanel numberSystems={numberSystems} bill={bill} />
      </div>
    </Page>
  );
}
