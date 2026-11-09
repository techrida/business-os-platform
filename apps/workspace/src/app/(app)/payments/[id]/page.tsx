import { randomUUID } from 'node:crypto';

import type { AllocationDto, PaymentDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { getCustomer } from '@/components/p2/customers/api';
import { getDocument } from '@/components/p2/crm/verification-api';
import { downloadHref, fileOf, type FileView } from '@/components/p2/crm/verification-file';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { getPayment, listPaymentAllocations } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';
import { formatBytes, scanLabel, shortId } from '@/lib/kernel-ui';

import { actionsFor, methodLabel, paymentStatusMeta } from '../_lib/status';
import styles from '../payments.module.css';

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
                Proof {shortId(documentId)} could not be loaded. Reload the page to try again.
              </span>
            </li>
          );
        }
        const scan = scanLabel(file.status);
        return (
          <li key={documentId} className={styles.file}>
            {file.status === 'clean' ? (
              // A plain anchor: the route behind it issues a single-use signed link per call.
              <a href={downloadHref(file)} className={styles.wrap}>
                {file.filename}
              </a>
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

function AllocationsTable({
  rows,
  currency,
}: {
  rows: AllocationDto[];
  currency: PaymentDto['currency'];
}) {
  if (rows.length === 0) {
    return <p className={styles.note}>This payment has not been allocated to any invoice yet.</p>;
  }
  return (
    <Table caption="Allocations of this payment" minWidth={560}>
      <thead>
        <tr>
          <Th>Invoice</Th>
          <Th align="end">Amount</Th>
          <Th>Allocated on</Th>
          <Th>Note</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const reversal = row.reversesAllocationId !== null;
          return (
            <tr key={row.id}>
              <Td nowrap>
                <Link href={`/invoices/${encodeURIComponent(row.invoiceId)}`}>
                  Invoice {shortId(row.invoiceId)}
                </Link>
              </Td>
              <Td align="end" nowrap>
                <span className={reversal ? styles.negative : styles.amount}>
                  {money(row.amount, currency)}
                </span>
              </Td>
              <Td nowrap>{when(row.createdAt, 'date')}</Td>
              <Td>
                <span className={styles.wrap}>
                  {reversal ? `Reversed${row.reason ? `: ${row.reason}` : ''}` : (row.reason ?? '')}
                </span>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

function facts(p: PaymentDto, customerName: string): Fact[] {
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
    { key: 'amount', label: 'Cash received', value: money(p.amount, p.currency) },
    {
      key: 'tds',
      label: 'Tax withheld (TDS)',
      value:
        Number(p.tdsWithheld) > 0
          ? `${money(p.tdsWithheld, p.currency)}${p.withholdingCode ? ` · ${p.withholdingCode}` : ''}`
          : 'None',
    },
    {
      key: 'settles',
      label: 'Settles',
      value: <strong>{money(p.settles, p.currency)}</strong>,
    },
    {
      key: 'advance',
      label: 'Customer advance (not yet allocated)',
      value: money(p.unallocatedAmount, p.currency),
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
      value: `${shortId(p.submittedBy)} · ${p.submittedVia === 'portal' ? 'customer portal' : 'staff entry'}`,
    },
  ];
  if (p.verifiedBy !== null && p.verifiedAt !== null) {
    out.push({
      key: 'verified',
      label: 'Verified by',
      value: `${shortId(p.verifiedBy)} · ${when(p.verifiedAt)}`,
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

export default async function PaymentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const here = `/payments/${id}`;
  const session = await requireStaffSession(here);

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
  const [customer, allocations, proofs] = await Promise.all([
    getCustomer(session, payment.customerId).catch(() => null),
    listPaymentAllocations(session, id).catch(() => null),
    loadProofs(session, payment.proofDocumentIds),
  ]);

  const meta = paymentStatusMeta(payment.status);
  const actions = actionsFor(payment.status);
  const customerName = customer?.legalName ?? `Customer ${shortId(payment.customerId)}`;

  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Payments', href: '/payments' },
          { label: payment.number ?? 'Payment awaiting verification' },
        ]}
      />
      <PageHeader
        title={payment.number ?? 'Payment awaiting verification'}
        status={<Badge tone={meta.tone}>{meta.label}</Badge>}
        description={`${money(payment.amount, payment.currency)} from ${customerName}`}
        actions={
          <div className={styles.actions}>
            <ReviewDialogs
              paymentId={payment.id}
              version={payment.version}
              number={payment.number}
              actions={actions}
              keys={{ verify: randomUUID(), reject: randomUUID(), reverse: randomUUID() }}
            />
          </div>
        }
      />

      <div className={styles.stack}>
        <Panel title="Payment" description="What was received and what it settles.">
          <FactList facts={facts(payment, customerName)} />
        </Panel>

        {payment.npr !== null ? (
          <Panel
            title="Value in NPR"
            description="Frozen when Finance verified the payment, so reports never drift."
          >
            <FactList
              facts={[
                { key: 'npr', label: 'Amount in NPR', value: money(payment.npr.amountNpr, 'NPR') },
                { key: 'rate', label: 'Rate', value: payment.npr.rate },
                { key: 'source', label: 'Rate source', value: payment.npr.rateSource },
                { key: 'date', label: 'Rate date', value: when(payment.npr.rateDate, 'date') },
              ]}
            />
          </Panel>
        ) : null}

        <Panel
          title="Proof of payment"
          description="Bank slips and receipts. A file can be opened once it has passed the virus scan."
        >
          <ProofList proofs={proofs} />
        </Panel>

        <Panel
          title="Allocations"
          description="How the verified amount settles invoices. Reversals are listed as their own rows."
        >
          {allocations === null ? (
            <Alert tone="warning" role="status">
              The allocations could not be loaded. Reload the page to try again.
            </Alert>
          ) : (
            <AllocationsTable rows={allocations} currency={payment.currency} />
          )}
        </Panel>
      </div>
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
