import type { ReactNode } from 'react';

import styles from './centered-page.module.css';

/** A full-height page with its content centred: staff-only, sign-in errors, the dev switcher. */
export function CenteredPage({
  children,
  width = 'narrow',
}: {
  children: ReactNode;
  width?: 'narrow' | 'wide' | 'split';
}) {
  return (
    <div className={styles.page}>
      <div className={styles[width]}>{children}</div>
    </div>
  );
}
