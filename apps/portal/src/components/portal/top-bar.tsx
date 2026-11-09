import { Brand } from '@/components/shell/brand';
import { Button } from '@/components/ui/button';
import { PORTAL_LABEL } from '@/lib/brand';

import styles from './top-bar.module.css';
import { TopBarNav } from './top-bar-nav';

/**
 * The portal's top bar (the page's `banner`): the brand with a "Customer portal" label, the
 * Quotations, Invoices and Payments links, and Sign out. It stays a direct child of the layout,
 * outside <main>, so it keeps the banner role.
 */
export function TopBar() {
  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <Brand />
        <span className={styles.label}>{PORTAL_LABEL}</span>
      </div>
      <TopBarNav />
      {/* POST, not a link: signing out changes state, so a crawler or prefetch must not trigger it. */}
      <form method="post" action="/auth/logout">
        <Button type="submit" variant="secondary" size="small">
          Sign out
        </Button>
      </form>
    </header>
  );
}
