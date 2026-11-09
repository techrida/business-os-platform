import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { requireStaffSession } from '@/lib/bff';

import { PaymentRequestEntry } from '../forms';

export const metadata: Metadata = { title: 'New payment request · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewPaymentRequestPage() {
  const session = await requireStaffSession('/payables/payment-requests/new');
  return (
    <Page width="narrow">
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
      {hasPermission(session.roles, 'payables.payment.request') ? (
        <Panel title="Request details">
          <PaymentRequestEntry idempotencyKey={randomUUID()} />
        </Panel>
      ) : (
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      )}
    </Page>
  );
}
