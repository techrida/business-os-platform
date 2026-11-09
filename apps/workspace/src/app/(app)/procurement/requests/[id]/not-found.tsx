import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** A request id that does not exist, belongs to another requester or entity, or is not an id at all. */
export default function PurchaseRequestNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[
          { label: 'Purchase requests', href: '/procurement/requests' },
          { label: 'Not found' },
        ]}
      />
      <EmptyState
        title="We could not find that purchase request."
        icon="search"
        action={<LinkButton href="/procurement/requests">Back to purchase requests</LinkButton>}
      >
        The link may be old, the request may have been removed, or it may belong to another
        requester.
      </EmptyState>
    </Page>
  );
}
