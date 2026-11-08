import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** A customer id that does not exist, was removed, or is not a customer id at all. */
export default function CustomerNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Customers', href: '/customers' }, { label: 'Not found' }]} />
      <EmptyState
        title="We could not find that customer."
        icon="search"
        action={<LinkButton href="/customers">Back to customers</LinkButton>}
      >
        The link may be old, or the customer may have been removed.
      </EmptyState>
    </Page>
  );
}
