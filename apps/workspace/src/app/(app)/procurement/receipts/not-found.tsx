import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** An id that is not a receipt or purchase order, or one in another legal entity: the same answer for both. */
export default function ReceiptNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[{ label: 'Receipts', href: '/procurement/receipts' }, { label: 'Not found' }]}
      />
      <EmptyState
        title="We could not find that receipt."
        icon="search"
        action={<LinkButton href="/procurement/receipts">Back to receipts</LinkButton>}
      >
        It may have been removed, or it belongs to another legal entity. If you were following a
        link, open the purchase order again and use its receipts button.
      </EmptyState>
    </Page>
  );
}
