import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** A vendor id that does not exist, was removed, or is not a vendor id at all. */
export default function VendorNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Vendors', href: '/vendors' }, { label: 'Not found' }]} />
      <EmptyState
        title="We could not find that vendor."
        icon="search"
        action={<LinkButton href="/vendors">Back to vendors</LinkButton>}
      >
        The link may be old, or the vendor may have been removed.
      </EmptyState>
    </Page>
  );
}
