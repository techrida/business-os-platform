'use client';

import type { VendorPortalCapability } from '@bos/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import styles from './vendor.module.css';

/** `owns` lists the paths an area covers; Onboarding is the landing page, so it owns `/vendor` only. */
const AREAS = [
  { label: 'Onboarding', href: '/vendor', exact: true },
  { label: 'Purchase orders', href: '/vendor/purchase-orders', exact: false },
  { label: 'Bills', href: '/vendor/bills', exact: false },
] as const;

/** True when `pathname` is the area's page or one under it (`/vendor/bills` owns `/vendor/bills/abc`). */
function owns(area: (typeof AREAS)[number], pathname: string): boolean {
  return area.exact
    ? pathname === area.href
    : pathname === area.href || pathname.startsWith(`${area.href}/`);
}

/**
 * The vendor links in the top bar, by what the vendor may do. A vendor who can only onboard sees
 * Onboarding and nothing that would answer 403; a blocked one sees no links. A Client Component
 * only to know the current path, for the highlight and `aria-current`.
 */
export function VendorNav({ capability }: { capability: VendorPortalCapability }) {
  const pathname = usePathname();
  if (capability === 'none') return null;
  const areas = capability === 'onboarding_only' ? AREAS.slice(0, 1) : AREAS;
  return (
    <nav className={styles.nav} aria-label="Vendor portal">
      {areas.map((area) => {
        const active = owns(area, pathname);
        return (
          <Link
            key={area.href}
            href={area.href}
            className={`${styles.link}${active ? ` ${styles.active}` : ''}`}
            aria-current={active ? 'page' : undefined}
          >
            {area.label}
          </Link>
        );
      })}
    </nav>
  );
}
