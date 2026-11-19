import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

export default function SalesOrderNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[{ label: 'Sales Orders', href: '/sales-orders' }, { label: 'Not found' }]}
      />
      <EmptyState
        title="Sales order unavailable"
        icon="search"
        action={<LinkButton href="/sales-orders">Back to sales orders</LinkButton>}
      >
        Check the link or ask your administrator for access.
      </EmptyState>
    </Page>
  );
}
