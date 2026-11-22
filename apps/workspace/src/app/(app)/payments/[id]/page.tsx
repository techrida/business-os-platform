import { randomUUID } from 'node:crypto';

import type { AllocationDto, PaymentDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { getCustomer } from '@/components/p2/customers/api';
import { getDocument } from '@/components/p2/crm/verification-api';
import {
  downloadHref,
  previewHref,
  fileOf,
  type FileView,
} from '@/components/p2/crm/verification-file';
import { FilePreviewDialog } from '@/components/ui/file-preview-dialog';
import { Button } from '@/components/ui/button';
import { FocusOnArrival } from '@/components/ui/focus-on-arrival';
import { Icon } from '@/components/ui/icon';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import {
  getCustomerAdvance,
  getCustomerStatement,
  getPayment,
  listPaymentAllocations,
} from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { formatBytes, scanLabel } from '@/lib/kernel-ui';
import { getPermissionCheck } from '@/lib/live-permissions';

import { actionsFor, methodLabel, paymentStatusMeta } from '../_lib/status';
import styles from '../payments.module.css';

import { AllocatePanel } from './allocate-panel';
import { DeallocateDialog } from './deallocate-dialog';
import { ReviewDialogs } from './review-dialogs';

export const metadata: Metadata = { title: 'Payment · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Proof = { documentId: string; file: FileView | null };

/** Each proof is read on its own, so one missing file does not hide the others. */
async function loadProofs(
  session: Awaited<ReturnType<typeof requireStaffSession>>,
  ids: readonly string[],
): Promise<Proof[]> {
  return Promise.all(
    ids.map(async (documentId): Promise<Proof> => {
      try {
        return { documentId, file: fileOf(await getDocument(session, documentId)) };
      } catch {
        return { documentId, file: null };
      }
    }),
  );
}

function ProofList({ proofs }: { proofs: Proof[] }) {
  if (proofs.length === 0) {
    return <p className={styles.note}>No proof was attached to this payment.</p>;
  }
  return (
    <ul className={styles.files}>
      {proofs.map(({ documentId, file }) => {
        if (file === null) {
          return (
            <li key={documentId} className={styles.file}>
              <span className={styles.quiet}>
                Payment proof could not be loaded. Reload the page to try again.
              </span>
            </li>
          );
        }
        const scan = scanLabel(file.status);
        return (
          <li key={documentId} className={styles.file}>
            {file.status === 'clean' ? (
              <FilePreviewDialog
                name={file.filename}
                mimeType={file.mimeType}
                previewUrl={previewHref(file)}
                downloadUrl={downloadHref(file)}
                trigger={
                  <Button variant="tertiary" size="small" className={styles.fileTrigger}>
                    <Icon name="file-text" size={16} />
                    {file.filename}
                  </Button>
                }
              />
            ) : (
              <span className={styles.wrap}>{file.filename}</span>
            )}
            <span className={styles.quiet}>{formatBytes(file.sizeBytes)}</span>
            <Badge
              tone={scan.tone === 'good' ? 'success' : scan.tone === 'wait' ? 'warning' : 'error'}
            >
              {scan.text}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

/** What the allocations table needs to offer "Deallocate": null when the person cannot. */
interface DeallocateAccess {
  paymentId: string;
  /** One idempotency key per allocation row, generated on the server for this render. */
  keys: ReadonlyMap<string, string>;
}

/** A live allocation: not itself a reversal, and no later row reverses it. */
function liveAllocationIds(rows: readonly AllocationDto[]): Set<string> {
  const reversed = new Set(
    rows.flatMap((r) => (r.reversesAllocationId ? [r.reversesAllocationId] : [])),
  );
  return new Set(
    rows.filter((r) => r.reversesAllocationId === null && !reversed.has(r.id)).map((r) => r.id),
  );
}

function AllocationsTable({
  rows,
  currency,
  labels,
  deallocate,
  numberSystems,
}: {
  rows: AllocationDto[];
  currency: PaymentDto['currency'];
  /** Invoice id to invoice number, from the customer statement when it could be read. */
  labels: ReadonlyMap<string, string>;
  deallocate: DeallocateAccess | null;
  numberSystems: NumberSystems;
}) {
  if (rows.length === 0) {
    return <p className={styles.note}>This payment has not been allocated to any invoice yet.</p>;
  }
  const live = liveAllocationIds(rows);
  return (
    <Table caption="Allocations of this payment" minWidth={deallocate !== null ? 720 : 560}>
      <thead>
        <tr>
          <Th>Invoice</Th>
          <Th align="end">Amount</Th>
          <Th>Allocated on</Th>
          <Th>Note</Th>
          {deallocate !== null ? <Th>Action</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const reversal = row.reversesAllocationId !== null;
          const label = labels.get(row.invoiceId) ?? 'Open invoice';
          const key = live.has(row.id) ? deallocate?.keys.get(row.id) : undefined;
          return (
            <tr key={row.id}>
              <Td nowrap>
                <Link href={`/invoices/${encodeURIComponent(row.invoiceId)}`}>{label}</Link>
              </Td>
              <Td align="end" nowrap>
                <span className={reversal ? styles.negative : styles.amount}>
                  {money(row.amount, currency, numberSystems)}
                </span>
              </Td>
              <Td nowrap>{when(row.createdAt, 'date')}</Td>
              <Td>
                <span className={styles.wrap}>
                  {reversal ? `Reversed${row.reason ? `: ${row.reason}` : ''}` : (row.reason ?? '')}
                </span>
              </Td>
              {deallocate !== null ? (
                <Td>
                  {key !== undefined ? (
                    <DeallocateDialog
                      paymentId={deallocate.paymentId}
                      allocationId={row.id}
                      label={label}
                      idempotencyKey={key}
                      reloadHref={`/payments/${encodeURIComponent(deallocate.paymentId)}`}
                    />
                  ) : null}
                </Td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function facts(p: PaymentDto, customerName: string, numberSystems: NumberSystems): Fact[] {
  const out: Fact[] = [
    {
      key: 'customer',
      label: 'Customer',
      value: (
        <Link href={`/customers/${encodeURIComponent(p.customerId)}`} className={styles.wrap}>
          {customerName}
        </Link>
      ),
    },
    { key: 'method', label: 'Method', value: methodLabel(p.method) },
    { key: 'received', label: 'Received on', value: when(p.receivedOn, 'date') },
    { key: 'amount', label: 'Cash received', value: money(p.amount, p.currency, numberSystems) },
    {
      key: 'tds',
      label: 'Tax withheld (TDS)',
      value:
        Number(p.tdsWithheld) > 0
          ? `${money(p.tdsWithheld, p.currency, numberSystems)}${p.withholdingCode ? ` · ${p.withholdingCode}` : ''}`
          : 'None',
    },
    {
      key: 'settles',
      label: 'Settles',
      value: <strong>{money(p.settles, p.currency, numberSystems)}</strong>,
    },
    {
      key: 'advance',
      label: 'Left to allocate',
      value: money(p.unallocatedAmount, p.currency, numberSystems),
    },
    {
      key: 'reference',
      label: 'Bank reference',
      value:
        p.bankReference !== null ? <span className={styles.wrap}>{p.bankReference}</span> : 'None',
    },
    {
      key: 'submitted',
      label: 'Recorded by',
      value: p.submittedVia === 'portal' ? 'Customer portal' : 'Staff entry',
    },
  ];
  if (p.verifiedBy !== null && p.verifiedAt !== null) {
    out.push({
      key: 'verified',
      label: 'Verified at',
      value: when(p.verifiedAt),
    });
  }
  if (p.rejectionReason !== null) {
    out.push({
      key: 'rejection',
      label: 'Reason for rejection',
      value: <span className={styles.wrap}>{p.rejectionReason}</span>,
      wide: true,
    });
  }
  return out;
}

/** One optional read: a failure (a missing role, an outage) becomes null, and the page words the gap. */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const here = `/payments/${id}`;
  const session = await requireStaffSession(here);
  const numberSystems = await getNumberSystems();

  if (!UUID.test(id)) {
    return (
      <Problem title="That is not a payment" message="Open a payment from the payments list." />
    );
  }

  let payment: PaymentDto;
  try {
    payment = await getPayment(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) {
      return (
        <Problem
          title="Payment not found"
          message="It may have been removed, or it is not in your area."
        />
      );
    }
    if (f.status === 403) {
      return (
        <Problem
          tone="info"
          title="Your roles do not include payments"
          message="Payments are for the accounts and finance team. Ask an administrator if you need access."
        />
      );
    }
    return <Problem title="The payment did not load" message={f.message} reloadHref={here} />;
  }

  // The rest is context: if it fails the payment itself still shows, with words in the gap.
  // Allocating and reviewing check live grants (and server `payment.can` when present); the API still decides.
  const allowed = await getPermissionCheck(session);
  const canAllocate = payment.status === 'verified' && allowed('payment.allocate');
  const [customer, allocations, proofs, openItems, advance] = await Promise.all([
    getCustomer(session, payment.customerId).catch(() => null),
    listPaymentAllocations(session, id).catch(() => null),
    loadProofs(session, payment.proofDocumentIds),
    canAllocate
      ? attempt(() =>
          getCustomerStatement(session, payment.customerId, {
            openOnly: true,
            currency: payment.currency,
          }),
        )
      : Promise.resolve(null),
    canAllocate
      ? attempt(async () => {
          const rows = await getCustomerAdvance(session, payment.customerId);
          // No row for this currency is the server saying the customer has no credit in it.
          return rows.find((r) => r.currency === payment.currency)?.amount ?? '0.00';
        })
      : Promise.resolve(null),
  ]);

  // Labels for the allocations table. A fully settled invoice is not in the open-only list, so the
  // full statement is read, and only when there is something to label.
  const statement =
    allocations !== null && allocations.length > 0
      ? await attempt(() =>
          getCustomerStatement(session, payment.customerId, { currency: payment.currency }),
        )
      : null;
  const labels = new Map(
    [...(statement ?? []), ...(openItems ?? [])].map((i) => [i.invoiceId, i.number] as const),
  );
  const deallocate: DeallocateAccess | null =
    canAllocate && allocations !== null
      ? {
          paymentId: payment.id,
          keys: new Map([...liveAllocationIds(allocations)].map((rowId) => [rowId, randomUUID()])),
        }
      : null;

  const meta = paymentStatusMeta(payment.status);
  const actions =
    payment.can !== undefined
      ? {
          verify: payment.can.verify,
          reject: payment.can.reject,
          reverse: payment.can.reverse,
        }
      : allowed('payment.verify')
        ? actionsFor(payment.status)
        : { verify: false, reject: false, reverse: false };
  const hasActions = actions.verify || actions.reject || actions.reverse;
  const customerName = customer?.legalName ?? 'Customer details unavailable';

  return (
    <Page>
      <FocusOnArrival />
      <Breadcrumb
        items={[
          { label: 'Payments', href: '/payments' },
          { label: payment.number ?? 'Payment awaiting verification' },
        ]}
      />
      <PageHeader
        title={payment.number ?? 'Payment awaiting verification'}
        status={<Badge tone={meta.tone}>{meta.label}</Badge>}
        description={`${money(payment.amount, payment.currency, numberSystems)} from ${customerName}`}
        actions={
          hasActions ? (
            <div className={styles.actions}>
              <ReviewDialogs
                key={payment.version}
                paymentId={payment.id}
                version={payment.version}
                number={payment.number}
                actions={actions}
                keys={{ verify: randomUUID(), reject: randomUUID(), reverse: randomUUID() }}
              />
            </div>
          ) : null
        }
      />

      {payment.can?.verifyBlockedBySod ? (
        <Alert tone="info" role="status" title="Verification requires another reviewer">
          You recorded this payment, so someone else must verify it.
        </Alert>
      ) : null}

      <div className={styles.stack}>
        <Panel title="Payment overview">
          <FactList facts={facts(payment, customerName, numberSystems)} />
        </Panel>

        <Panel as="aside" title="Proof of payment" description="Scanned bank slips and receipts.">
          <ProofList proofs={proofs} />
        </Panel>
      </div>
      {payment.npr !== null ? (
        <Panel title="Value in NPR" description="Exchange rate at verification.">
          <FactList
            facts={[
              {
                key: 'npr',
                label: 'Amount in NPR',
                value: money(payment.npr.amountNpr, 'NPR', numberSystems),
              },
              { key: 'rate', label: 'Rate', value: payment.npr.rate },
              { key: 'source', label: 'Rate source', value: payment.npr.rateSource },
              { key: 'date', label: 'Rate date', value: when(payment.npr.rateDate, 'date') },
            ]}
          />
        </Panel>
      ) : null}

      {canAllocate ? (
        <AllocatePanel
          paymentId={payment.id}
          currency={payment.currency}
          remaining={payment.unallocatedAmount}
          advance={advance}
          items={openItems}
          idempotencyKey={randomUUID()}
          reloadHref={here}
        />
      ) : null}

      <Panel
        title="Allocations"
        description="How the verified amount settles invoices. Reversals are listed as their own rows."
      >
        {allocations === null ? (
          <Alert tone="warning" role="status">
            The allocations could not be loaded. Reload the page to try again.
          </Alert>
        ) : (
          <AllocationsTable
            numberSystems={numberSystems}
            rows={allocations}
            currency={payment.currency}
            labels={labels}
            deallocate={deallocate}
          />
        )}
      </Panel>
    </Page>
  );
}

function Problem({
  title,
  message,
  tone = 'error',
  reloadHref,
}: {
  title: string;
  message: string;
  tone?: 'error' | 'info';
  reloadHref?: string;
}) {
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Payments', href: '/payments' }, { label: 'Payment' }]} />
      <Alert
        tone={tone}
        role="alert"
        title={title}
        actions={
          reloadHref !== undefined ? <Link href={reloadHref}>Reload this payment</Link> : null
        }
      >
        {message}
      </Alert>
    </Page>
  );
}
