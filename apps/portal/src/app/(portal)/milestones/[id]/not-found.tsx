import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The same answer for a bad id, someone else's order, a draft or cancelled order and an unknown id, so the page
 * never says whether an order exists.
 */
export default function OrderNotFound() {
  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Order not found</h1>
      </div>
      <EmptyState
        title="We could not find that order"
        icon="list-checks"
        action={<LinkButton href="/milestones">Your milestones</LinkButton>}
      >
        Check the link you followed, or open your milestones to find it.
      </EmptyState>
    </main>
  );
}
