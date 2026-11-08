import type { ReactNode } from 'react';

import styles from './centered-page.module.css';

/** A full-height page with its content centred: staff-only, sign-in errors, the dev switcher. */
export function CenteredPage({
  children,
  width = 'narrow',
}: {
  children: ReactNode;
  width?: 'narrow' | 'wide';
}) {
  return (
    <div className={styles.page}>
      <div className={width === 'wide' ? styles.wide : styles.narrow}>{children}</div>
    </div>
  );
}
