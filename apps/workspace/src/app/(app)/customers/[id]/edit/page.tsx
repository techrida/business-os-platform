import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { updateCustomerAction } from '@/components/p2/customers/actions';
import { customerCan, getCustomerDetail, type CustomerDetail } from '@/components/p2/customers/api';
import { CustomerForm } from '@/components/p2/customers/customer-form';
import { valuesOfCustomer } from '@/components/p2/customers/forms';
import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page } from '@/components/ui/page';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { getGrants, hasGrant } from '@/lib/grants';

export const metadata: Metadata = { title: 'Edit Organization · Business OS' };
export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const here = `/customers/${id}/edit`;
  const back = `/customers/${id}`;
  const session = await requireStaffSession(here);

  // A person who cannot write at all is told so without the page fetching the customer.
  if (!hasGrant(await getGrants(session), 'customer.write')) {
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[
            { label: 'Organizations', href: '/customers' },
            { label: 'Organization', href: back },
            { label: 'Edit' },
          ]}
        />
        <Alert tone="info" role="status" title="Your roles do not include editing organizations">
          Ask an administrator if you need to. You can still read this organization.
        </Alert>
      </Page>
    );
  }

  let customer: CustomerDetail;
  // Read alongside the customer; it never throws (a failed read gives the default list).
  const enabledRead = loadEnabledCurrencies(session);
  try {
    customer = await getCustomerDetail(session, id);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Organizations', href: '/customers' }, { label: 'Edit Organization' }]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403
              ? 'You cannot open this organization'
              : 'This organization did not load'
          }
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const crumbs = [
    { label: 'Organizations', href: '/customers' },
    { label: customer.legalName, href: back },
    { label: 'Edit' },
  ];

  // This customer in particular: the API decides on the record (an own-scope grant reaches only owned ones).
  if (!customerCan(customer).write) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <Alert tone="info" role="status" title="You cannot edit this organization">
          Ask its account owner or an administrator. You can still read this organization.
        </Alert>
      </Page>
    );
  }

  if (customer.mergedIntoId !== null) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <Alert
          tone="warning"
          role="status"
          title="This record was merged into another organization."
        >
          Edit the organization it was merged into instead.{' '}
          <a href={`/customers/${encodeURIComponent(customer.mergedIntoId)}`}>
            Open that organization
          </a>
        </Alert>
      </Page>
    );
  }

  const enabledCurrencies = await enabledRead;
  return (
    <Page>
      <Breadcrumb items={crumbs} />
      <CustomerForm
        action={updateCustomerAction}
        mode="edit"
        initial={valuesOfCustomer(customer)}
        customerId={customer.id}
        version={customer.version}
        cancelHref={back}
        reloadHref={here}
        description={customer.number}
        enabledCurrencies={enabledCurrencies}
        lockIdentity={customer.verification?.approved === true}
      />
    </Page>
  );
}
