import Link from 'next/link';

import styles from './admin.module.css';
import { requireSession } from './guard';
import { PageHead } from './ui';

const AREAS = [
  {
    href: '/admin/users',
    title: 'Users',
    text: 'See who has access, invite a colleague and change what roles they hold.',
  },
  {
    href: '/admin/roles',
    title: 'Roles',
    text: 'What each role may do, and how far each permission reaches (own, department, customer organisation, all).',
  },
  {
    href: '/admin/workflows',
    title: 'Workflows',
    text: 'Approval routes and their thresholds: edit a draft, publish it, and manage approval groups and delegations.',
  },
  {
    href: '/admin/settings',
    title: 'Settings',
    text: 'FX rates, document number series, VAT, enabled currencies and approval timing.',
  },
] as const;

export default async function AdminOverviewPage() {
  await requireSession('/admin');
  return (
    <>
      <PageHead title="Administration">
        Setup that changes how the whole organisation works. Each change is recorded in the audit
        trail with your name.
      </PageHead>
      <ul className={styles.linkList}>
        {AREAS.map((area) => (
          <li key={area.href}>
            <Link href={area.href}>{area.title}</Link>
            <p>{area.text}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
