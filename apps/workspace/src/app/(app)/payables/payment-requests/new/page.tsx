import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { listPaymentRequestItems, type PaymentRequestItem } from '@/lib/api-payables';

import { PaymentRequestEntry } from '../forms';
import { paymentRequestFailure } from '../failure';

export const metadata: Metadata = { title: 'New payment request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPaymentRequestPage() {
  const session = await requireStaffSession('/payables/payment-requests/new');
  const allowed = hasPermission(session.roles, 'payables.payment.request');
  let items: PaymentRequestItem[] = [];
  let problem: string | undefined;
  const enabledCurrencies = allowed ? await loadEnabledCurrencies(session) : [];
  if (allowed) {
    try {
      items = await listPaymentRequestItems(session);
    } catch (err) {
      problem = paymentRequestFailure(err).message;
    }
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
