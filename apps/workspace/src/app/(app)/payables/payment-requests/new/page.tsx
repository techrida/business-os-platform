import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { listPaymentRequestItems, type PaymentRequestItem } from '@/lib/api-payables';
import { listPaymentRequestOrders } from '@/lib/api-payables-orders';

import { PO_STATUS_LABEL } from '../../../procurement/orders/_lib/model';

import { PaymentRequestEntry } from '../forms';
import { paymentRequestFailure } from '../failure';

export const metadata: Metadata = { title: 'New payment request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPaymentRequestPage() {
  const session = await requireStaffSession('/payables/payment-requests/new');
  // Live grants (GET /v1/me), not the role defaults: an admin may grant payment requests to any role, at any scope.
  const allowed = hasGrant(await getGrants(session), 'payables.payment.request');
  let items: PaymentRequestItem[] = [];
  let orders: { id: string; vendorId: string; label: string }[] = [];
  let problem: string | undefined;
  const enabledCurrencies = allowed ? await loadEnabledCurrencies(session) : [];
  if (allowed) {
    try {
      items = await listPaymentRequestItems(session);
    } catch (err) {
      problem = paymentRequestFailure(err).message;
    }
    // The order is optional on a request: if the picker does not load, the request goes without one.
    orders = await listPaymentRequestOrders(session).then(
      (rows) =>
        rows.map((o) => ({
          id: o.id,
          vendorId: o.vendorId,
          label: `${o.number} · ${PO_STATUS_LABEL[o.status].text}`,
        })),
      () => [],
    );
  }
  return (
    <Page>
      <Breadcrumb
        items={[
          { label: 'Payment requests', href: '/payables/payment-requests' },
          { label: 'New request' },
        ]}
      />
      <PageHeader
        title="New payment request"
        description="Settle approved bills for one vendor and one currency. The platform supplies the total and verified destination account."
      />
      {allowed ? (
        problem ? (
          <Alert
            tone="error"
            role="alert"
            actions={<Link href="/payables/payment-requests/new">Reload this page</Link>}
          >
            {problem}
          </Alert>
        ) : items.length === 0 ? (
          <Alert tone="info" role="status">
            No approved bill balances are available for a payment request. Existing requests may
            have claimed the remaining balances.
          </Alert>
        ) : (
          <PaymentRequestEntry
            idempotencyKey={randomUUID()}
            items={items}
            orders={orders}
            enabledCurrencies={enabledCurrencies}
          />
        )
      ) : (
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      )}
    </Page>
  );
}
