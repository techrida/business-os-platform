import { Skeleton } from '@/components/ui/panel';

import styles from './roles.module.css';

// Shown inside the Access layout (title and tabs stay put) while By role reads the catalogue. The
// blocks are hidden from assistive technology; the status text is what is announced.
export default function AccessRolesLoading() {
  return (
    <div className={styles.frame} aria-busy="true">
      <p className="sr-only" role="status">
        Loading roles...
      </p>
      <div className={styles.list}>
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} height={44} />
        ))}
      </div>
      <div className={styles.main}>
        <Skeleton height={28} width="min(14rem, 100%)" />
        <Skeleton height={20} width="min(28rem, 100%)" />
        <Skeleton height={200} />
        <Skeleton height={200} />
      </div>
    </div>
  );
}
