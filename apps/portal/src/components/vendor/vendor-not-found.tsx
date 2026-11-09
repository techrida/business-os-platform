import pageStyles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The one answer for a bad id, someone else's order or bill, and a record not yet visible, so a
 * page never says whether something exists behind an id.
 */
export function VendorNotFound() {
  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Page not found</h1>
      </div>
      <EmptyState
        title="We could not find that page"
        icon="file-text"
        action={<LinkButton href="/vendor">Back to your account</LinkButton>}
      >
        Check the link you followed, or open your account to find what you need.
      </EmptyState>
    </main>
  );
}
