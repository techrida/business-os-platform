import type { VendorPortalOnboardingView } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

import { formatDay } from '../portal/quotation-status';
import styles from './vendor.module.css';
import { KYC_DOC_LABEL, KYC_STATE_LOOK, VENDOR_STATUS_LOOK } from './vendor-status';

/**
 * The vendor's onboarding progress: where the account stands, what that lets them do, and the
 * KYB checklist with one state per document. It reads only `VendorPortalOnboardingView`, which has
 * no reviewer note, so nothing a reviewer wrote can reach this markup.
 */
export function OnboardingView({ view }: { view: VendorPortalOnboardingView }) {
  const look = VENDOR_STATUS_LOOK[view.status];
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
                </tr>
              </thead>
              <tbody>
                {view.documents.map((doc) => {
                  const state = KYC_STATE_LOOK[doc.state];
                  return (
                    <tr key={doc.docType}>
                      <th scope="row">{KYC_DOC_LABEL[doc.docType]}</th>
                      <td>
                        <Badge tone={state.tone}>{state.label}</Badge>
                      </td>
                      <td className={styles.nowrap}>
                        {doc.validUntil ? formatDay(doc.validUntil) : '—'}
                      </td>
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
