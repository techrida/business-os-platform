import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** An id that is not a bill, or one in another legal entity: the same answer for both. */
export default function PayablesNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb items={[{ label: 'Bills', href: '/payables/bills' }, { label: 'Not found' }]} />
      <EmptyState
        title="We could not find that bill."
        icon="search"
        action={<LinkButton href="/payables/bills">Back to bills</LinkButton>}
      >
        It may have been removed, or it belongs to another legal entity. If you were following a
        link, open the bills list and find it there.
      </EmptyState>
    </Page>
  );
}
