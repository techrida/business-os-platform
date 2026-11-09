import { randomUUID } from 'node:crypto';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { todayInKathmandu } from '@/components/portal/quotation-status';
import styles from '@/components/portal/page.module.css';
import { ApiError } from '@/lib/api';
import { getPortalInvoice, getPortalInvoiceSettlement } from '@/lib/api.billing';
import { getSession } from '@/lib/session';

import { PaymentForm } from '../_components/payment-form';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Submit a payment, optionally from an invoice (`?invoice=<id>`). From an invoice, the currency and
 * the amount still open are the server's figures. A bad invoice id, a 404 and a 403 all show the
 * invoice not-found page, so this URL cannot be used to probe for invoices that are not the
 * customer's.
 */
export default async function NewPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ invoice?: string | string[] }>;
}) {
  const { invoice } = await searchParams;
  const invoiceId = typeof invoice === 'string' ? invoice : undefined;
  if (invoiceId !== undefined && !UUID.test(invoiceId)) notFound();
  const returnTo = `/auth/login?returnTo=${encodeURIComponent(
    invoiceId ? `/payments/new?invoice=${invoiceId}` : '/payments/new',
  )}`;

  const session = await getSession();
  if (!session) redirect(returnTo);

  let context: { id: string; number: string } | undefined;
  let currency: 'NPR' | 'INR' | 'USD' = 'NPR';
  let suggestedAmount = '';
  if (invoiceId !== undefined) {
    try {
      const [view, settlement] = await Promise.all([
        getPortalInvoice(session, invoiceId),
        getPortalInvoiceSettlement(session, invoiceId),
      ]);
      context = { id: view.id, number: view.number };
      currency = view.currency;
      suggestedAmount = settlement.openAmount;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
      if (err instanceof ApiError && err.status === 401) redirect(returnTo);
      throw err;
    }
  }

  return (
    <main className={styles.main}>
      <p className={styles.back}>
        <Link href={context ? `/invoices/${context.id}` : '/payments'}>
          {context ? '← Back to the invoice' : '← Your payments'}
        </Link>
      </p>
      <div className={styles.head}>
        <h1 className={styles.title}>Submit a payment</h1>
        <p className={styles.lede}>
          Tell us about a payment you have sent and attach the bank slip or receipt. We check it
          before it counts against your invoices.
        </p>
      </div>
      <PaymentForm
        idempotencyKey={randomUUID()}
        today={todayInKathmandu()}
        invoice={context}
        defaultCurrency={currency}
        suggestedAmount={suggestedAmount}
      />
    </main>
  );
}
