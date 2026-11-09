import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** An RFQ that does not exist, is not a valid id, or belongs to another entity. */
export default function RfqNotFound() {
  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Requests for quotation', href: '/procurement/rfqs' }, { label: 'RFQ' }]}
      />
      <EmptyState
        title="We could not find that RFQ."
        icon="search"
        action={
          <LinkButton href="/procurement/rfqs" variant="secondary">
            Back to RFQs
          </LinkButton>
        }
      >
        It may have been removed, or it belongs to another entity.
      </EmptyState>
    </Page>
  );
}
