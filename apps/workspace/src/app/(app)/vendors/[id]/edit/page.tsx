import type { VendorDto } from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page } from '@/components/ui/page';
import { getVendor } from '@/lib/api-vendors';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { VendorForm } from '../../_components/vendor-form';
import { vendorFailure } from '../../_lib/failure';
import { identityLocked, isEditable } from '../../_lib/model';
import { updateVendorAction } from '../../actions';

export const metadata: Metadata = { title: 'Edit vendor · Business OS' };
export const dynamic = 'force-dynamic';

export default async function EditVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isGuid(id)) notFound();
  const here = `/vendors/${id}/edit`;
  const back = `/vendors/${id}`;
  const session = await requireStaffSession(here);
  const allowed = await getPermissionCheck(session);

  // A person who cannot write is told so without the page fetching anything for them.
  if (!allowed('vendor.write')) {
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[
            { label: 'Vendors', href: '/vendors' },
            { label: 'Vendor', href: back },
            { label: 'Edit' },
          ]}
        />
        <Alert tone="info" role="status" title="Your roles do not include editing vendors">
          Ask an administrator if you need to. You can still read this vendor.
        </Alert>
      </Page>
    );
  }

  let vendor: VendorDto;
  try {
    vendor = await getVendor(session, id);
  } catch (err) {
    const f = vendorFailure(err, 'load');
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb items={[{ label: 'Vendors', href: '/vendors' }, { label: 'Edit vendor' }]} />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={f.status === 403 ? 'You cannot open this vendor' : 'This vendor did not load'}
          actions={f.status !== 403 ? <a href={here}>Try again</a> : null}
        >
          {f.message}
        </Alert>
      </Page>
    );
  }

  const crumbs = [
    { label: 'Vendors', href: '/vendors' },
    { label: vendor.legalName, href: back },
    { label: 'Edit' },
  ];

  if (!isEditable(vendor.status)) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <Alert tone="warning" role="status" title="This vendor can no longer be edited.">
          A blocked or archived vendor is read-only. <a href={back}>Back to the vendor</a>
        </Alert>
      </Page>
    );
  }

  // The vendor's own flag is the API's answer for this record (a role can hold vendor.write outside its scope).
  if (vendor.can?.write === false) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <Alert tone="info" role="status" title="You cannot edit this vendor">
          Ask an administrator if you need to. You can still read this vendor.{' '}
          <a href={back}>Back to the vendor</a>
        </Alert>
      </Page>
    );
  }

  return (
    <Page>
      <Breadcrumb items={crumbs} />
      <VendorForm
        title="Edit vendor"
        description={vendor.legalName}
        action={updateVendorAction}
        mode="edit"
        initial={{
          legalName: vendor.legalName,
          tradeName: vendor.tradeName ?? '',
          kind: vendor.kind,
          pan: vendor.pan ?? '',
          vatRegistered: vendor.vatRegistered,
          country: vendor.country,
          addressLine: vendor.address?.line ?? '',
          addressCity: vendor.address?.city ?? '',
        }}
        vendorId={vendor.id}
        version={vendor.version}
        lockIdentity={identityLocked(vendor.status)}
        cancelHref={back}
        reloadHref={here}
      />
    </Page>
  );
}
