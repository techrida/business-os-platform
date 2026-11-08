import { APP_NAME } from '@/lib/nav';
import { Icon } from '@/components/ui/icon';

import styles from './brand.module.css';

/** Brand lockup: the star mark and the product name. */
export function Brand({ className }: { className?: string }) {
  return (
    <span className={[styles.brand, className].filter(Boolean).join(' ')}>
      <span className={styles.mark}>
        <Icon name="star" size={16} />
      </span>
      {/* The sidebar hides the name in the rail through this attribute. */}
      <span className={styles.name} data-brand-name="">
        {APP_NAME}
      </span>
    </span>
  );
}
