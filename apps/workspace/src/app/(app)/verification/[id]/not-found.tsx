import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** A customer id that does not exist, was removed, or is not a customer id at all. */
export default function VerificationNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[{ label: 'Verification', href: '/verification' }, { label: 'Not found' }]}
      />
      <EmptyState
        title="We could not find that verification case."
        icon="search"
        action={<LinkButton href="/verification">Back to verification</LinkButton>}
      >
        The case may be unavailable or outside your access. Return to verification or ask the
        customer owner for help.
      </EmptyState>
    </Page>
  );
}
