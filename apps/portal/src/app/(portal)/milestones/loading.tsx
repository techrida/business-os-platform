import styles from '@/components/portal/page.module.css';

/** Shown while the milestones pages load on the server (the order list and one order). */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <div className={styles.head}>
        <h1 className={styles.title}>Milestones</h1>
        <p className={styles.lede} role="status">
          Loading…
        </p>
      </div>
      <div className={styles.skeleton} aria-hidden="true" />
    </main>
  );
}
