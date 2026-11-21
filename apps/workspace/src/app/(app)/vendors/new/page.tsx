import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { getGrants } from '@/lib/grants';

import { VendorForm } from '../_components/vendor-form';
import { EMPTY_VENDOR_VALUES } from '../_lib/forms';
import { vendorGrants } from '../_lib/model';
import { createVendorAction } from '../actions';

export const metadata: Metadata = { title: 'Add vendor · Business OS' };
export const dynamic = 'force-dynamic';

const DESCRIPTION =
  'The vendor starts as a draft. Start its KYB review afterwards; it can be approved only once that review is approved.';

export default async function NewVendorPage() {
  const session = await requireStaffSession('/vendors/new');
  const mayWrite = vendorGrants(await getGrants(session)).write;

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Vendors', href: '/vendors' }, { label: 'Add vendor' }]} />
      {mayWrite ? (
        <VendorForm
          title="Add vendor"
          description={DESCRIPTION}
          action={createVendorAction}
          mode="create"
          initial={EMPTY_VENDOR_VALUES}
          // One key per render of this page: a double click or a retry creates the vendor once.
          idempotencyKey={randomUUID()}
          cancelHref="/vendors"
          reloadHref="/vendors/new"
        />
      ) : (
        <>
          <PageHeader title="Add vendor" description={DESCRIPTION} />
          <Alert tone="info" role="status" title="Your roles do not include adding vendors">
            Ask an administrator if you need to. You can still read vendors.
          </Alert>
        </>
      )}
    </Page>
  );
}
