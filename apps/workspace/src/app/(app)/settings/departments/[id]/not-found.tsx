import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page } from '@/components/ui/page';

/** A department id that does not exist, belongs to another company or may not be opened. */
export default function DepartmentNotFound() {
  return (
    <Page width="narrow">
      <Breadcrumb
        items={[{ label: 'Departments', href: '/settings/departments' }, { label: 'Not found' }]}
      />
      <EmptyState
        title="This department could not be found."
        icon="search"
        action={<LinkButton href="/settings/departments">Back to departments</LinkButton>}
      >
        The link may be old, or the department may belong to another company.
      </EmptyState>
    </Page>
  );
}
