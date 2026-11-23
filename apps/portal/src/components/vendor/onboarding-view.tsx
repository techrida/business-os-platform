import type { PortalDisplay, VendorPortalOnboardingView } from '@bos/contracts';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { displayFormat } from '@/lib/display';

import { DetailsChangedNote } from './details-changed-note';
import styles from './vendor.module.css';
import { KYC_DOC_LABEL, KYC_STATE_LOOK, VENDOR_STATUS_LOOK } from './vendor-status';

/**
 * The vendor's onboarding progress: where the account stands, what that lets them do, and the
 * KYB checklist with one state per document. It reads only `VendorPortalOnboardingView`, which has
 * no reviewer note, so nothing a reviewer wrote can reach this markup.
 */
export function OnboardingView({
  view,
  display,
}: {
  view: VendorPortalOnboardingView;
  display?: PortalDisplay;
}) {
  const { day } = displayFormat(display);
  const look = VENDOR_STATUS_LOOK[view.status];
  // A blocked vendor cannot send anything; every other capability can send a KYC document.
  const canSend = view.capability !== 'none';
  return (
    <div className={styles.document}>
      <Card as="section" aria-labelledby="vendor-status-heading" className={styles.statusCard}>
        <div className={styles.statusRow}>
          <h2 id="vendor-status-heading" className={styles.statusLabel}>
            Your account
          </h2>
          <Badge tone={look.tone}>{look.label}</Badge>
        </div>
        <p className={styles.summary}>{look.summary}</p>
      </Card>

      {view.detailsChanged ? (
        <DetailsChangedNote detailsChanged={view.detailsChanged} {...(display && { display })} />
      ) : null}

      <section aria-labelledby="vendor-checklist-heading" className={styles.section}>
        <h2 id="vendor-checklist-heading" className={styles.sectionTitle}>
          Onboarding checklist
        </h2>
        {view.documents.length === 0 ? (
          <p className={styles.muted}>No documents are required yet.</p>
        ) : (
          <div className={styles.tableFrame}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Onboarding checklist</caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Status</th>
                  <th scope="col">Valid until</th>
                  {canSend ? (
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Send</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {view.documents.map((doc) => {
                  const state = KYC_STATE_LOOK[doc.state];
                  const label = KYC_DOC_LABEL[doc.docType];
                  return (
                    <tr key={doc.docType}>
                      <th scope="row">{label}</th>
                      <td>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>
                      <td className={styles.nowrap}>
                        {doc.validUntil ? day(doc.validUntil) : '—'}
                      </td>
                      {canSend ? (
                        <td className={styles.nowrap}>
                          <Link
                            href={`/vendor/onboarding/upload?doc=${encodeURIComponent(doc.docType)}`}
                            className={styles.rowLink}
                          >
                            Send a document
                            <span className={styles.visuallyHidden}> for {label}</span>
                          </Link>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
