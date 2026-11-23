import { randomUUID } from 'node:crypto';

import { notFound, redirect } from 'next/navigation';

import { Alert } from '@/components/portal/alert';
import pageStyles from '@/components/portal/page.module.css';
import { todayInKathmandu } from '@/components/portal/quotation-status';
import { EmptyState } from '@/components/ui/empty-state';
import { KYC_DOC_LABEL, KYC_STATE_LOOK } from '@/components/vendor/vendor-status';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding } from '@/lib/api.vendor';
import { getSession } from '@/lib/session';

import { loadVendor } from '../../load';
import styles from '../../_upload/upload.module.css';
import { DetailsChangedNote } from '@/components/vendor/details-changed-note';
import { KycForm } from './_components/kyc-form';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/onboarding/upload';

/**
 * Send a KYC document. Open to a vendor who can onboard, which includes one whose account is
 * still being set up or checked; a closed account gets the no-access notice in place, and the API
 * is the authority (a 403 here shows the same notice). The choices are the vendor's own
 * checklist, so a document nobody asked for cannot be picked, and `?doc=` preselects one.
 */
export default async function UploadKycPage({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string | string[]; sent?: string | string[] }>;
}) {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const result = await loadVendor(() => getVendorOnboarding(session), HERE);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();
  const view = result.data;
  if (view.capability === 'none') return <VendorNoAccess />;

  const { doc, sent } = await searchParams;
  const choices = view.documents.map((d) => ({
    docType: d.docType,
    label: `${KYC_DOC_LABEL[d.docType]} (${KYC_STATE_LOOK[d.state].label.toLowerCase()})`,
  }));
  // A document that is missing, rejected or expired is the likeliest one to be sent next.
  const first =
    view.documents.find(
      (d) => d.state === 'missing' || d.state === 'rejected' || d.state === 'expired',
    ) ?? view.documents[0];
  const wanted =
    typeof doc === 'string' ? view.documents.find((d) => d.docType === doc) : undefined;
  const initial = wanted ?? first;
  // One key per render, also the React key: every render mounts a fresh form with its own key.
  const key = randomUUID();

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Send a document</h1>
        <p className={pageStyles.lede}>
          Upload a document from your onboarding checklist. Our team checks each one; you can see
          where it stands on your account page.
        </p>
      </div>
      {view.detailsChanged ? (
        <DetailsChangedNote detailsChanged={view.detailsChanged} className={styles.confirmation}>
          {' '}
          A file you sent before the change cannot be used.
        </DetailsChangedNote>
      ) : null}
      {sent === '1' ? (
        <Alert tone="success" role="status" className={styles.confirmation}>
          We received your document. Our team will check it.
        </Alert>
      ) : null}
      {initial === undefined ? (
        <EmptyState title="No documents are required yet" icon="inbox">
          When we need a document from you, it will be listed on your account page.
        </EmptyState>
      ) : (
        <KycForm
          key={key}
          idempotencyKey={key}
          choices={choices}
          initialDocType={initial.docType}
          today={todayInKathmandu()}
        />
      )}
      <p className={styles.back}>
        <a href="/vendor">Back to your account</a>
      </p>
    </main>
  );
}
