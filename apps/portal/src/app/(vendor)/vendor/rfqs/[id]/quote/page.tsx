import { randomUUID } from 'node:crypto';

import { portalEnabledCurrencies } from '@bos/contracts';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Alert } from '@/components/portal/alert';
import pageStyles from '@/components/portal/page.module.css';
import { todayInKathmandu } from '@/components/portal/quotation-status';
import { DEADLINE_PASSED_TEXT } from '@/components/vendor/rfq-deadline';
import { formatDeadline, isPastDeadline } from '@/components/vendor/rfq-list';
import { trimQuantity } from '@/components/vendor/vendor-status';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, getVendorRfq } from '@/lib/api.vendor';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import uploadStyles from '../../../_upload/upload.module.css';
import { isUuid, loadVendor } from '../../../load';
import { QuoteForm } from './_components/quote-form';
import styles from './quote.module.css';

export const dynamic = 'force-dynamic';

/**
 * Submit a quotation for one request. A bad id is not-found before any API call, and so is every
 * 404 on the request (foreign, closed, unknown). Needs a full vendor account: any other, or a 403,
 * shows the no-access notice, and the request is not read for a vendor who cannot quote. Once the
 * deadline has passed the form is replaced by a notice (F1-Q47: the API refuses a late quotation;
 * it checks again on submit). The currency picker offers only the currencies the company has switched
 * on (D44), read once from the portal display.
 */
export default async function QuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sent?: string | string[] }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const here = `/vendor/rfqs/${id}/quote`;

  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(here)}`);

  const onboarding = await loadVendor(() => getVendorOnboarding(session), here);
  if (onboarding.kind === 'forbidden') return <VendorNoAccess />;
  if (onboarding.kind === 'missing') notFound();
  if (onboarding.data.capability !== 'full') return <VendorNoAccess />;

  // Started before the request read so the two overlap; it never throws (defaults on failure).
  const display = getPortalDisplay(session);
  const result = await loadVendor(() => getVendorRfq(session, id), here);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();
  const rfq = result.data;

  const { sent } = await searchParams;
  const past = isPastDeadline(rfq.deadline, new Date());
  const key = randomUUID();
  const currencies = portalEnabledCurrencies(await display);

  return (
    <main className={pageStyles.main}>
      <p className={pageStyles.back}>
        <Link href={`/vendor/rfqs/${id}`}>← Back to {rfq.number}</Link>
      </p>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Submit a quotation</h1>
        <p className={pageStyles.lede}>
          Send us your prices for {rfq.number}. Quotations close {formatDeadline(rfq.deadline)}{' '}
          (Nepal time).
        </p>
      </div>
      {sent === '1' ? (
        <Alert tone="success" role="status" className={uploadStyles.confirmation}>
          We received your quotation. Our team will review it against the other quotations for this
          request.
        </Alert>
      ) : null}
      {past && sent !== '1' ? (
        <Alert tone="warning" title="The deadline for this request has passed">
          Quotations closed on {formatDeadline(rfq.deadline)} (Nepal time). {DEADLINE_PASSED_TEXT}
        </Alert>
      ) : null}
      <section aria-labelledby="quote-items-heading" className={styles.summary}>
        <h2 id="quote-items-heading" className={styles.summaryTitle}>
          {rfq.number}: {rfq.lines.length === 1 ? '1 item' : `${rfq.lines.length} items`} to quote
        </h2>
        {rfq.lines.length === 0 ? null : (
          <ul
            className={styles.items}
            // Scrolls when the list is long, so the keyboard needs to reach it.
            tabIndex={0}
            aria-labelledby="quote-items-heading"
          >
            {rfq.lines.map((line) => (
              <li key={line.lineNo}>
                <span>
                  {line.lineNo}. {line.description}
                </span>
                <span className={styles.qty}>
                  {trimQuantity(line.quantity)} {line.uom}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {past ? null : (
        <QuoteForm
          key={key}
          idempotencyKey={key}
          rfqId={id}
          today={todayInKathmandu()}
          currencies={currencies}
          numberSystems={(await display).numberSystems}
        />
      )}
    </main>
  );
}
