import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { createCustomerAction } from '@/components/p2/customers/actions';
import { CustomerForm } from '@/components/p2/customers/customer-form';
import { EMPTY_CUSTOMER_VALUES } from '@/components/p2/customers/forms';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';

export const metadata: Metadata = { title: 'Add customer · Business OS' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  const session = await requireStaffSession('/customers/new');
  const mayWrite = hasPermission(session.roles, 'customer.write');

  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Customers', href: '/customers' }, { label: 'Add customer' }]} />
      <PageHeader
        title="Add customer"
        description="A customer is shared by every legal entity. Payment terms are set per entity afterwards."
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
        />
      ) : (
        <Alert tone="info" role="status" title="Your roles do not include adding customers">
          Ask an administrator if you need to. You can still read customers.
        </Alert>
      )}
    </Page>
  );
}
