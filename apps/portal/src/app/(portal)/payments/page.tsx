import { redirect } from 'next/navigation';

import { Alert } from '@/components/portal/alert';
import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api';
import { listPortalPayments } from '@/lib/api.billing';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { PaymentList } from './_components/payment-list';

export const dynamic = 'force-dynamic';

const LOGIN = '/auth/login?returnTo=%2Fpayments';

/**
 * The customer's own payments with their status. The API lists the session's party only, and the
 * strict list schema refuses a body with any other field (a 502, shown by the error page).
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string | string[] }>;
}) {
  const session = await getSession();
  if (!session) redirect(LOGIN);

  const display = getPortalDisplay(session);
  let items;
  try {
    items = await listPortalPayments(session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect(LOGIN);
    if (err instanceof ApiError && err.status === 403) redirect('/no-access');
    throw err;
  }
  const { submitted } = await searchParams;

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your payments</h1>
        <p className={styles.lede}>
          Payments you have sent us, and where each one stands with our finance team.
        </p>
        <div>
          <LinkButton size="small" href="/payments/new">
            Submit a payment
          </LinkButton>
        </div>
      </div>
      {submitted === '1' ? (
        <Alert tone="success" role="status" className={styles.confirmation}>
          Thank you. We have your payment and proof. Our finance team will check it, and its status
          will change here from &ldquo;Awaiting verification&rdquo;.
        </Alert>
      ) : null}
      {items.length === 0 ? (
        <EmptyState
          title="No payments yet"
          icon="credit-card"
          action={<LinkButton href="/payments/new">Submit a payment</LinkButton>}
        >
          When you send us a payment, upload your bank slip here so we can match it to your invoice.
        </EmptyState>
      ) : (
        <PaymentList items={items} display={await display} />
      )}
    </main>
  );
}
