import styles from './admin.module.css';

// Shown while an admin page waits for the API. The admin pages make several requests in parallel,
// so a slow one would otherwise leave the previous screen frozen with no sign that anything happens.
export default function AdminLoading() {
  return (
    <p className={styles.lede} role="status" aria-busy="true">
      Loading...
    </p>
  );
}
