import { randomUUID } from 'node:crypto';

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { Alert } from '@/components/portal/alert';
import styles from '@/components/portal/page.module.css';
import { QuotationClosed } from '@/components/portal/quotation-closed';
import { isQuotationClosed } from '@/lib/quotation-closed';
import { QuotationNextStep } from '@/components/portal/quotation-next-step';
import { canRespond, todayInKathmandu } from '@/components/portal/quotation-status';
import { QuotationView } from '@/components/portal/quotation-view';
import { RespondPanel } from '@/components/portal/respond-panel';
import { ApiError, getPortalQuotation } from '@/lib/api';
import { displayFormat } from '@/lib/display';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESPONDED: Record<string, string> = {
  accepted: 'Thank you. Your acceptance is recorded.',
  rejected: 'Your response is recorded. Thank you for letting us know.',
};

/**
 * One quotation for the signed-in customer. A bad id, a 404 and a 403 all show the same "Quotation
 * not found" (not-found.tsx): the customer must not learn whether someone else's quotation, or a
 * draft, exists. The API filters by the session's party; the strict view schema is the second wall.
 */
export default async function QuotationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ responded?: string | string[] }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const returnTo = `/auth/login?returnTo=${encodeURIComponent(`/quotations/${id}`)}`;

  const session = await getSession();
  if (!session) redirect(returnTo);

  let view;
  try {
    view = await getPortalQuotation(session, id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
    if (err instanceof ApiError && err.status === 401) redirect(returnTo);
    // A sent quotation the company cancelled (a Lost deal): say so, since the customer got the link by mail.
    if (isQuotationClosed(err)) return <QuotationClosed />;
    throw err;
  }

  const today = todayInKathmandu();
  const { responded } = await searchParams;
  // Only when the status agrees: the query string alone is not proof, and anyone can send the link.
  const confirmation =
    typeof responded === 'string' && responded === view.status ? RESPONDED[responded] : undefined;

  return (
    <main className={styles.main}>
      <p className={styles.back}>
        <Link href="/">← Your quotations</Link>
      </p>
      {confirmation ? (
        <Alert tone="success" role="status" className={styles.confirmation}>
          {confirmation}
        </Alert>
      ) : null}
      {view.status === 'accepted' && view.afterAcceptance ? (
        <QuotationNextStep after={view.afterAcceptance} className={styles.confirmation} />
      ) : null}
      <QuotationView
        view={view}
        today={today}
        respond={
          <RespondPanel
            quotationId={view.id}
            respondability={canRespond(view, today)}
            acceptKey={randomUUID()}
            rejectKey={randomUUID()}
            summary={`${view.number} Rev ${view.revisionNo} for ${displayFormat(view.display).money(view.totals.total, view.currency)}`}
            reloadHref={`/quotations/${view.id}`}
          />
        }
      />
    </main>
  );
}
