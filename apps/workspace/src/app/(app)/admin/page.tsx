import { LinkCard, LinkCardList } from '@/components/ui/link-card';
import { Page, PageHeader } from '@/components/ui/page';

import { requireSession } from './guard';

const AREAS = [
  {
    href: '/admin/users',
    title: 'Users',
    text: 'See who has access, invite a colleague and change what roles they hold.',
  },
  {
    href: '/admin/roles',
    title: 'Roles & Permissions',
    text: 'What each role may do, and how far each permission reaches.',
  },
  {
    href: '/admin/workflows',
    title: 'Approval workflows',
    text: 'Approval routes and thresholds, approval groups and delegations.',
  },
  {
    href: '/admin/settings',
    title: 'Settings',
    text: 'FX rates, document number series, VAT, currencies and approval timing.',
  },
] as const;

export default async function AdminOverviewPage() {
  await requireSession('/admin');
  return (
    <Page>
      <PageHeader
        title="Administration"
        description="Setup that changes how the whole organisation works. Each change is recorded in the audit trail with your name."
      />
      <LinkCardList>
        {AREAS.map((area) => (
          <LinkCard key={area.href} href={area.href} title={area.title}>
            {area.text}
          </LinkCard>
        ))}
      </LinkCardList>
    </Page>
  );
}
