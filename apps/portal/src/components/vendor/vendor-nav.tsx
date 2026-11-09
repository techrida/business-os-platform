'use client';

import type { VendorPortalCapability } from '@bos/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import styles from './vendor.module.css';

interface Area {
  label: string;
  href: string;
  /** Onboarding is the landing page, so it owns `/vendor` only; the others own everything under them. */
  exact: boolean;
  /** Pages that write (RFQ answers, bank change): a read-only vendor does not see them. */
  fullOnly?: boolean;
}

const AREAS: readonly Area[] = [
  { label: 'Onboarding', href: '/vendor', exact: true },
  { label: 'Purchase orders', href: '/vendor/purchase-orders', exact: false },
  { label: 'Bills', href: '/vendor/bills', exact: false },
  { label: 'RFQs', href: '/vendor/rfqs', exact: false, fullOnly: true },
  { label: 'Bank account', href: '/vendor/bank-account', exact: false, fullOnly: true },
];

/** True when `pathname` is the area's page or one under it (`/vendor/bills` owns `/vendor/bills/abc`). */
function owns(area: Area, pathname: string): boolean {
  return area.exact
    ? pathname === area.href
    : pathname === area.href || pathname.startsWith(`${area.href}/`);
}

/**
 * The vendor links in the top bar, by what the vendor may do. A vendor who can only onboard sees
 * Onboarding and nothing that would answer 403; a read-only one sees the same minus the
 * full-only areas; a blocked one sees no links. A Client Component
 * only to know the current path, for the highlight and `aria-current`.
 */
export function VendorNav({ capability }: { capability: VendorPortalCapability }) {
  const pathname = usePathname();
  if (capability === 'none') return null;
  const areas =
    capability === 'onboarding_only'
      ? AREAS.slice(0, 1)
      : AREAS.filter((area) => capability === 'full' || !area.fullOnly);
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
