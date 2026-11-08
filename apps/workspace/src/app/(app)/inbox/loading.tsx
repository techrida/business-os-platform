import styles from '../kit.module.css';

/** Shown while the inbox loads: row-shaped placeholders so the page does not jump. */
export default function InboxLoading() {
  return (
    <main id="main" className={styles.page} aria-busy="true">
      <div className={styles.pageHead}>
        <h1 className={styles.title}>Inbox</h1>
      </div>
      <p className={styles.visuallyHidden} role="status">
        Loading your approvals
      </p>
      <div className={styles.list} aria-hidden="true">
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
        <div className={styles.skeleton} />
      </div>
    </main>
  );
}
