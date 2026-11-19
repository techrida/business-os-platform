import { PAYMENT_REQUEST_STATUSES, PaymentRequestStatusSchema } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { listPaymentRequests, type PaymentRequestListItem } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';

import { poMoney } from '../../procurement/orders/_lib/model';
import styles from '../payables.module.css';
import { paymentRequestFailure } from './failure';
import { PAYMENT_STATUS } from './model';

export const metadata: Metadata = { title: 'Payment requests · Business OS' };
export const dynamic = 'force-dynamic';

export default async function PaymentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await requireStaffSession('/payables/payment-requests');
  const numberSystem = await getNumberSystem();
  const allowed = hasPermission(session.roles, 'payables.payment.request');
  const header = (
    <PageHeader
      title="Payment requests"
      description="Instructions to pay approved vendor bills. Approval does not send money."
      actions={
        allowed ? (
          <LinkButton href="/payables/payment-requests/new">New payment request</LinkButton>
        ) : null
      }
    />
  );
  if (!allowed)
    return (
      <Page>
        {header}
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      </Page>
    );
  const params = await searchParams;
  const raw = typeof params.status === 'string' ? params.status : '';
  const parsed = PaymentRequestStatusSchema.safeParse(raw);
  const status = parsed.success ? parsed.data : undefined;
  let rows: PaymentRequestListItem[];
  try {
    rows = await listPaymentRequests(session, status);
  } catch (err) {
    const f = paymentRequestFailure(err);
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title="Payment requests did not load"
        >
          {f.message}
        </Alert>
      </Page>
    );
  }
  return (
    <Page>
      {header}
      {raw !== '' && !parsed.success ? (
        <Alert tone="warning" role="status">
          That is not a request status. Every status is shown below.
        </Alert>
      ) : null}
      <form
        method="get"
        action="/payables/payment-requests"
        className={styles.filter}
        role="search"
      >
        <Field label="Status">
          {(control) => (
            <Select name="status" defaultValue={status ?? ''} {...control}>
              <option value="">Every status</option>
              {PAYMENT_REQUEST_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PAYMENT_STATUS[value].text}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary">
          Show requests
        </Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No payment requests with this status." icon="banknote" headingLevel={2}>
          Create a draft for approved vendor bills, or choose another status.
        </EmptyState>
      ) : (
        <Table caption="Payment requests, newest first" minWidth={700}>
          <thead>
            <tr>
              <Th>Request</Th>
              <Th>Vendor</Th>
              <Th>Status</Th>
              <Th>Vendor bank account</Th>
              <Th align="end">Amount</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <Td>
                  <Link href={`/payables/payment-requests/${row.id}`}>
                    {row.number ?? 'Draft request'}
                  </Link>
                </Td>
                <Td>
                  <Link href={`/vendors/${row.vendorPartyId}`}>View vendor</Link>
                </Td>
                <Td>
                  <Badge tone={PAYMENT_STATUS[row.status].tone}>
                    {PAYMENT_STATUS[row.status].text}
                  </Badge>
                </Td>
                <Td>Ending {row.bankLast4}</Td>
                <Td align="end">{poMoney(row.totalAmount, row.currency, numberSystem)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Page>
  );
}
