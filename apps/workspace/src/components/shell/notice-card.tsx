import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { APP_NAME } from '@/lib/nav';

import { Brand } from './brand';
import styles from './notice-card.module.css';

/** Optional footer links. A link renders only when its URL is given (see `getFooterLinks`). */
export interface NoticeFooterLinks {
  helpUrl?: string | undefined;
  privacyUrl?: string | undefined;
}

/**
 * A notice for pages outside the shell (no access, sign-in error): a split card with the form
 * column (brand, one h1, text, the actions, a footer) and a decorative panel that only appears
 * when the card is wide. It is the page's `main`.
 *
 * It stays free of server-only code because error boundaries render it in the browser. Server
 * pages pass `footerLinks={getFooterLinks()}`; without it the footer shows the copyright only.
 */
export function NoticeCard({
  title,
  children,
  actions,
  footerLinks,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  footerLinks?: NoticeFooterLinks | undefined;
}) {
  const helpUrl = footerLinks?.helpUrl;
  const privacyUrl = footerLinks?.privacyUrl;
  return (
    <Card as="main" className={styles.notice}>
      <div className={styles.split}>
        <div className={styles.column}>
          <Brand />
          <div className={styles.content}>
            <h1 className={styles.title}>{title}</h1>
            <div className={styles.body}>{children}</div>
            {actions ? <div className={styles.actions}>{actions}</div> : null}
          </div>
          <footer className={styles.footer}>
            <small>
              © {new Date().getFullYear()} {APP_NAME}
            </small>
            {helpUrl || privacyUrl ? (
              <nav className={styles.links} aria-label="Support">
                {helpUrl ? <a href={helpUrl}>Need help?</a> : null}
                {privacyUrl ? <a href={privacyUrl}>Privacy</a> : null}
              </nav>
            ) : null}
          </footer>
        </div>
        <NoticeAside />
      </div>
    </Card>
  );
}

/** Purely decorative, so it is hidden from assistive technology and holds nothing focusable. */
function NoticeAside() {
  return (
    <aside className={styles.aside} aria-hidden="true">
      <div className={styles.stage}>
        <div className={`${styles.miniCard} ${styles.cardA}`}>
          <span className={`${styles.bar} ${styles.barAccent}`} />
          <span className={styles.bar} />
          <span className={`${styles.bar} ${styles.barShort}`} />
        </div>
        <div className={`${styles.miniCard} ${styles.cardB}`}>
          <span className={`${styles.bar} ${styles.barShort}`} />
          <span className={styles.bar} />
          <span className={`${styles.bar} ${styles.barAccent}`} />
        </div>
        <div className={`${styles.miniCard} ${styles.cardC}`}>
          <span className={`${styles.bar} ${styles.barAccent}`} />
          <span className={styles.bar} />
          <span className={`${styles.bar} ${styles.barShort}`} />
          <span className={styles.bar} />
        </div>
      </div>
      <div className={styles.asideCopy}>
        <span className={styles.monogram}>
          <Icon name="star" size={20} />
        </span>
        <p className={styles.asideTitle}>A Unified Hub for Smarter Workplace operations</p>
        <p className={styles.asideBody}>
          Sales, invoicing and purchasing in one workspace, with a clear view of every customer and
          order.
        </p>
      </div>
      <span className={styles.pills}>
        <span className={styles.pillActive} />
        <span className={styles.pill} />
        <span className={styles.pill} />
        <span className={styles.pill} />
      </span>
    </aside>
  );
}
