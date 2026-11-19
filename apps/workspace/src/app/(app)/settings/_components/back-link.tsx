import Link from 'next/link';

import { Icon } from '@/components/ui/icon';

import styles from './chrome.module.css';

/**
 * "Settings" above a section's title. Shown only where the sub-sidebar is hidden (under 768px), by
 * CSS, so the server never has to know the viewport. Render it first inside the page's `Page`.
 */
export function BackToSettings() {
  return (
    <Link href="/settings" className={styles.back}>
      <Icon name="chevrons-left" size={16} />
      Settings
    </Link>
  );
}
