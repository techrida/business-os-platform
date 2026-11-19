import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { createCustomerAction } from '@/components/p2/customers/actions';
import { CustomerForm } from '@/components/p2/customers/customer-form';
import { EMPTY_CUSTOMER_VALUES } from '@/components/p2/customers/forms';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

export const metadata: Metadata = { title: 'Create Organization · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  const session = await requireStaffSession('/customers/new');
  const mayWrite = hasPermission(session.roles, 'customer.write');
  const enabledCurrencies = mayWrite ? await loadEnabledCurrencies(session) : [];

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Organizations', href: '/customers' }, { label: 'Create Organization' }]}
      />
      {mayWrite ? (
        <CustomerForm
          action={createCustomerAction}
          mode="create"
          initial={EMPTY_CUSTOMER_VALUES}
          // One key per render of this page: a double click or a retry creates the customer once.
          idempotencyKey={randomUUID()}
          cancelHref="/customers"
          reloadHref="/customers/new"
          description="Add a company record and the primary contact for quotations."
          enabledCurrencies={enabledCurrencies}
        />
      ) : (
        <>
          <PageHeader title="Create Organization" />
          <Alert tone="info" role="status" title="Your roles do not include adding organizations">
            You can still view organizations. Ask an administrator if you need edit access.
          </Alert>
        </>
      )}
    </Page>
  );
}
