import { randomUUID } from 'node:crypto';

import { portalEnabledCurrencies } from '@bos/contracts';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Alert } from '@/components/portal/alert';
import pageStyles from '@/components/portal/page.module.css';
import { todayInKathmandu } from '@/components/portal/quotation-status';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, listVendorPurchaseOrders } from '@/lib/api.vendor';
import { displayFormat } from '@/lib/display';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { isUuid, loadVendor } from '../../load';
import styles from '../../_upload/upload.module.css';
import { BillForm } from './_components/bill-form';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/bills/new';

/** An order a bill can still be for: issued or received against, not closed or cancelled. */
const BILLABLE = ['issued', 'partially_received', 'fully_received'];

/**
 * Submit a bill. Needs a full vendor account: one still being set up, suspended or closed gets
 * the no-access notice in place before any other call, and a 403 from the API shows the same
 * notice. The purchase orders to link are the vendor's own, read from the API; `?po=` preselects
 * one when it is in that list.
 */
export default async function NewBillPage({
  searchParams,
}: {
  searchParams: Promise<{ po?: string | string[]; sent?: string | string[] }>;
}) {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const onboarding = await loadVendor(() => getVendorOnboarding(session), HERE);
  if (onboarding.kind === 'forbidden') return <VendorNoAccess />;
  if (onboarding.kind === 'missing') notFound();
  if (onboarding.data.capability !== 'full') return <VendorNoAccess />;

  const display = getPortalDisplay(session);
  const orders = await loadVendor(() => listVendorPurchaseOrders(session), HERE);
  if (orders.kind === 'forbidden') return <VendorNoAccess />;
  if (orders.kind === 'missing') notFound();

  const { po, sent } = await searchParams;
  const shown = await display;
  const { money } = displayFormat(shown);
  const choices = orders.data
    .filter((o) => BILLABLE.includes(o.status))
    .map((o) => ({ id: o.id, label: `${o.number} (${money(o.total, o.currency)})` }));
  const initialOrderId =
    typeof po === 'string' && isUuid(po) && choices.some((c) => c.id === po) ? po : '';
  const key = randomUUID();

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Submit a bill</h1>
        <p className={pageStyles.lede}>
          Send us a bill you have issued. Our team checks it against your order before it is
          approved for payment.
        </p>
      </div>
      {sent === '1' ? (
        <Alert tone="success" role="status" className={styles.confirmation}>
          We received your bill. Our team will check it, and it will appear in your bills once we
          have entered it.
        </Alert>
      ) : null}
      <BillForm
        key={key}
        idempotencyKey={key}
        today={todayInKathmandu()}
        orders={choices}
        initialOrderId={initialOrderId}
        currencies={portalEnabledCurrencies(shown)}
        numberSystems={shown.numberSystems}
      />
      <p className={styles.back}>
        <Link href="/vendor/bills">Back to your bills</Link>
      </p>
    </main>
  );
}
