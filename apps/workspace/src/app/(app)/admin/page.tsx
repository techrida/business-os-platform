import { Icon } from '@/components/ui/icon';
import { LinkCard, LinkCardList } from '@/components/ui/link-card';
import { Page, PageHeader } from '@/components/ui/page';

import admin from './admin.module.css';
import { requireSession } from './guard';

const AREAS = [
  {
    href: '/admin/users',
    icon: 'users',
    title: 'Users',
    text: 'See who has access, invite a colleague and change what roles they hold.',
  },
  {
    href: '/admin/roles',
    icon: 'shield-check',
    title: 'Roles & Permissions',
    text: 'What each role may do, and how far each permission reaches.',
  },
  {
    href: '/admin/workflows',
    icon: 'git-branch',
    title: 'Approval workflows',
    text: 'Approval routes and thresholds, approval groups and delegations.',
  },
  {
    href: '/admin/settings',
    icon: 'settings',
    title: 'Settings',
    text: 'FX rates, document number series, VAT, currencies and approval timing.',
  },
] as const;

export default async function AdminOverviewPage() {
  await requireSession('/admin');
  return (
    <Page className={admin.page}>
      <PageHeader
        title="Administration"
        description="Setup that changes how the whole organisation works. Each change is recorded in the audit trail with your name."
      />
      <div className={admin.destinations}>
        <LinkCardList>
          {AREAS.map((area) => (
            <LinkCard key={area.href} href={area.href} title={area.title}>
              <Icon name={area.icon} size={20} className={admin.areaIcon} />
              {area.text}
            </LinkCard>
          ))}
        </LinkCardList>
      </div>
    </Page>
  );
}
