import Link from 'next/link';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { Icon } from './icon';
import styles from './page.module.css';

/**
 * The page's `main` uses the shared container, page spacing and responsive margins.
 * `narrow` has a 720px content cap for forms. It carries `id="main"`.
 */
export function Page({
  width = 'full',
  className,
  ...rest
}: ComponentPropsWithoutRef<'main'> & { width?: 'full' | 'narrow' }) {
  const cls = [styles.page, width === 'narrow' ? styles.narrow : undefined, className]
    .filter(Boolean)
    .join(' ');
  return <main id="main" className={cls} {...rest} />;
}

/**
 * Title block: the page's one `h1`, a status (a Badge), a one-line description and the page's
 * actions on the right. The description is a `<p>`; the title wraps rather than truncating.
 */
export function PageHeader({
  title,
  status,
  description,
  actions,
}: {
  title: ReactNode;
  status?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.header}>
      <div className={styles.headText}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {status}
        </div>
        {description ? <p className={styles.description}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}

export interface Crumb {
  label: string;
  /** Leave off on the current page (always the last crumb). */
  href?: string;
}

/** Breadcrumb trail (Figma 727:10637). The last crumb is the current page. */
export function Breadcrumb({ items }: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className={styles.crumbs}>
      <ol className={styles.crumbList}>
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${index}-${item.label}`} className={styles.crumb}>
              {item.href !== undefined && !last ? (
                <Link href={item.href} className={styles.crumbLink}>
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={styles.crumbCurrent}>
                  {item.label}
                </span>
              )}
              {last ? null : <Icon name="chevron-right" size={14} className={styles.crumbSep} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
