import { Skeleton } from '@/components/ui/panel';

import styles from './check.module.css';

// Shown inside the Access layout (title and tabs stay put) while the report loads. The blocks are
// hidden from assistive technology; the status text is what is announced.
export default function CheckPersonLoading() {
  return (
    <div className={styles.check} aria-busy="true">
      <p className="sr-only" role="status">
        Loading...
      </p>
      <Skeleton height={64} width="min(30rem, 100%)" />
      <Skeleton height={24} width="min(26rem, 100%)" />
      <Skeleton height={320} />
    </div>
  );
}
