import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page } from '@/components/ui/page';

/** An id that is not a purchase order, or one in another legal entity: the same answer for both. */
export default function PurchaseOrderNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[{ label: 'Purchase orders', href: '/procurement/orders' }, { label: 'Not found' }]}
      />
      <EmptyState
        title="We could not find that purchase order."
        icon="search"
        action={<LinkButton href="/procurement/orders">Back to purchase orders</LinkButton>}
      >
        It may have been removed, or it belongs to another legal entity.
      </EmptyState>
    </Page>
  );
}
