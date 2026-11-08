import styles from '@/components/portal/page.module.css';

/** Shown while a portal page loads on the server. */
export default function Loading() {
  return (
    <main className={styles.main} aria-busy="true">
      <div className={styles.head}>
        <h1 className={styles.title}>Your quotations</h1>
        <p className={styles.lede} role="status">
          Loading…
        </p>
      </div>
      <div className={styles.skeleton} aria-hidden="true" />
    </main>
  );
}
