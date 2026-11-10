import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { getPaymentRequest, type PaymentRequest } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';

import { poMoney } from '../../../procurement/orders/_lib/model';
import styles from '../../payables.module.css';
import { paymentRequestFailure } from '../failure';
import { PaymentRequestCommand } from '../forms';
import { PAYMENT_STATUS } from '../model';

export const metadata: Metadata = { title: 'Payment request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function PaymentRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const session = await requireStaffSession(`/payables/payment-requests/${id}`);
  if (!hasPermission(session.roles, 'payables.payment.request'))
    return (
      <Page>
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      </Page>
    );
  let request: PaymentRequest;
  try {
    request = await getPaymentRequest(session, id);
  } catch (err) {
    const f = paymentRequestFailure(err);
    if (f.status === 404) notFound();
    return (
      <Page>
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title="The payment request did not load"
        >
          {f.message}
        </Alert>
      </Page>
    );
  }
  const status = PAYMENT_STATUS[request.status];
  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Payment requests', href: '/payables/payment-requests' },
          { label: request.number ?? 'Draft request' },
        ]}
      />
      <PageHeader
        title={request.number ?? 'Draft payment request'}
        status={<Badge tone={status.tone}>{status.text}</Badge>}
        description="An instruction to pay approved vendor bills. Approval does not send money."
        actions={
          request.status === 'draft' ? (
            <div className={styles.headActions}>
              <PaymentRequestCommand id={id} idempotencyKey={randomUUID()} operation="submit" />
              <PaymentRequestCommand id={id} idempotencyKey={randomUUID()} operation="cancel" />
            </div>
          ) : null
        }
      />
      <div className={styles.stack}>
        <Panel title="Request">
          <FactList
            facts={[
              {
                key: 'vendor',
                label: 'Vendor',
                value: <Link href={`/vendors/${request.vendorPartyId}`}>View vendor</Link>,
              },
              {
                key: 'bank',
                label: 'Verified vendor account snapshot',
                value: `Ending ${request.bankLast4}`,
              },
              {
                key: 'source',
                label: 'Paying entity bank account',
                value: 'Selected paying account',
              },
              {
                key: 'total',
                label: 'Total requested',
                value: poMoney(request.totalAmount, request.currency),
              },
              {
                key: 'approval',
                label: 'Approval',
                value: request.approvalRequestId ? (
                  <Link href={`/inbox/${request.approvalRequestId}`}>
                    Open the approval request
                  </Link>
                ) : (
                  'Not submitted'
                ),
              },
              ...(request.cancelReason
                ? [{ key: 'reason', label: 'Cancellation reason', value: request.cancelReason }]
                : []),
            ]}
          />
        </Panel>
        <Panel title="Payable items">
          <Table caption="Requested bill items" minWidth={560}>
            <thead>
              <tr>
                <Th>Line</Th>
                <Th>Payable open item</Th>
                <Th align="end">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {request.lines.map((line) => (
                <tr key={line.id}>
                  <Td>{line.lineNo}</Td>
                  <Td>
                    <span className={styles.long}>Payable item {line.lineNo}</span>
                  </Td>
                  <Td align="end">{poMoney(line.amount, request.currency)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      </div>
    </Page>
  );
}
