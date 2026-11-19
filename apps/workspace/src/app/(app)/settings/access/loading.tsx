import { Skeleton } from '@/components/ui/panel';

import styles from './access.module.css';

// Shown under the Access heading and tabs (they come from layout.tsx) while an Access tab waits for
// the API: nine card outlines, one per area. The status text is what assistive technology hears.
export default function AccessLoading() {
  return (
    <div className={styles.skeletonCards} aria-busy="true">
      <p className="sr-only" role="status">
        Loading access settings…
      </p>
      {Array.from({ length: 9 }, (_, index) => (
        <Skeleton key={index} height={96} />
      ))}
    </div>
  );
}
