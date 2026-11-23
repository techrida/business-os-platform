import type { VendorPortalCapability } from '@bos/contracts';

import { Brand } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { VendorNav } from '@/components/vendor/vendor-nav';
import { PORTAL_LABEL } from '@/lib/brand';

import styles from './top-bar.module.css';
import { TopBarNav } from './top-bar-nav';

/** Shown beside the name on the vendor side, so a vendor knows which portal this is. */
const VENDOR_PORTAL_LABEL = 'Vendor portal';

/**
 * The portal banner shows the brand, caller-specific navigation and a POST sign-out form.
 * Customers keep quotation, invoice and payment links; vendor links follow live capability.
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
      {kind === 'vendor' ? <VendorNav capability={capability} /> : <TopBarNav />}
      {/* POST, not a link: signing out changes state, so a crawler or prefetch must not trigger it. */}
      <form noValidate method="post" action="/auth/logout">
        <Button type="submit" variant="secondary" size="small">
          Sign out
        </Button>
      </form>
    </header>
  );
}
