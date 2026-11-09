import type { VendorPortalCapability } from '@bos/contracts';

import { Brand } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { VendorNav } from '@/components/vendor/vendor-nav';
import { PORTAL_LABEL } from '@/lib/brand';

import styles from './top-bar.module.css';

/** Shown beside the name on the vendor side, so a vendor knows which portal this is. */
const VENDOR_PORTAL_LABEL = 'Vendor portal';

/**
 * The portal's top bar (the page's `banner`): the brand with a "Customer portal" label, and Sign
 * out. For a vendor (`kind="vendor"`) the label reads "Vendor portal" and the vendor links follow,
 * limited by what the vendor may do. Customers pass nothing and get the bar they always had. It
 * stays a direct child of the layout, outside <main>, so it keeps the banner role.
 */
export function TopBar({
  kind = 'customer',
  capability = 'none',
}: {
  kind?: 'customer' | 'vendor';
  capability?: VendorPortalCapability;
}) {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Brand />
        <span className={styles.label}>
          {kind === 'vendor' ? VENDOR_PORTAL_LABEL : PORTAL_LABEL}
        </span>
      </div>
      {kind === 'vendor' ? <VendorNav capability={capability} /> : null}
      {/* POST, not a link: signing out changes state, so a crawler or prefetch must not trigger it. */}
      <form method="post" action="/auth/logout">
        <Button type="submit" variant="secondary" size="small">
          Sign out
        </Button>
      </form>
    </header>
  );
}
