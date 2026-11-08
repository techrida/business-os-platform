import type { CustomerDto } from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { updateCustomerAction } from '@/components/p2/customers/actions';
import { getCustomer } from '@/components/p2/customers/api';
import { CustomerForm } from '@/components/p2/customers/customer-form';
import { valuesOfCustomer } from '@/components/p2/customers/forms';
import { isGuid } from '@/components/p2/customers/format';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

export const metadata: Metadata = { title: 'Edit customer · Business OS' };
export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const here = `/customers/${id}/edit`;
  const back = `/customers/${id}`;
  const session = await requireStaffSession(here);

  // A person who cannot write is told so without the page fetching anything for them.
  if (!hasPermission(session.roles, 'customer.write')) {
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[
            { label: 'Customers', href: '/customers' },
            { label: 'Customer', href: back },
            { label: 'Edit' },
          ]}
        />
        <Alert tone="info" role="status" title="Your roles do not include editing customers">
          Ask an administrator if you need to. You can still read this customer.
        </Alert>
      </Page>
    );
  }

  let customer: CustomerDto;
  try {
    customer = await getCustomer(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Customers', href: '/customers' }, { label: 'Edit customer' }]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this customer' : 'This customer did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const crumbs = [
    { label: 'Customers', href: '/customers' },
    { label: customer.legalName, href: back },
    { label: 'Edit' },
  ];

  if (customer.mergedIntoId !== null) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <Alert tone="warning" role="status" title="This record was merged into another customer.">
          Edit the customer it was merged into instead.{' '}
          <a href={`/customers/${encodeURIComponent(customer.mergedIntoId)}`}>Open that customer</a>
        </Alert>
      </Page>
    );
  }

  return (
    <Page width="narrow">
      <Breadcrumb items={crumbs} />
      <PageHeader title="Edit customer" description={customer.number} />
      <CustomerForm
        action={updateCustomerAction}
        mode="edit"
        initial={valuesOfCustomer(customer)}
        customerId={customer.id}
        version={customer.version}
        cancelHref={back}
        reloadHref={here}
      />
    </Page>
  );
}
