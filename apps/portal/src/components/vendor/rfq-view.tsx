import type { VendorPortalRfqView } from '@bos/contracts';

import { Alert } from '@/components/portal/alert';
import { LinkButton } from '@/components/ui/button';

import { DEADLINE_PASSED_TEXT } from './rfq-deadline';
import { formatDeadline, isPastDeadline } from './rfq-list';
import styles from './vendor.module.css';
import { trimQuantity } from './vendor-status';

/**
 * One request for quotation as the vendor sees it. It reads only `VendorPortalRfqView` (a strict
 * allow-list: number, deadline and the lines to price), so there is no estimate, budget or other
 * vendor here to show. Once the deadline has passed the quotation link goes and a notice says why
 * (F1-Q47: the API refuses a late quotation). `now` comes from the page.
 */
export function RfqView({ view, now }: { view: VendorPortalRfqView; now: Date }) {
  const past = isPastDeadline(view.deadline, now);
  return (
    <div className={styles.document}>
      <header className={styles.docHead}>
        <div className={styles.titleRow}>
          <h1 className={styles.docTitle}>{view.number}</h1>
        </div>
        {past ? (
          <Alert tone="warning" title="The deadline for this request has passed">
            Quotations closed on {formatDeadline(view.deadline)} (Nepal time).{' '}
            {DEADLINE_PASSED_TEXT}
          </Alert>
        ) : null}
        <dl className={styles.facts}>
          <div>
            <dt>Quotations close (Nepal time)</dt>
            <dd>{formatDeadline(view.deadline)}</dd>
          </div>
        </dl>
        {past ? null : (
          <div className={styles.download}>
            <LinkButton href={`/vendor/rfqs/${view.id}/quote`}>Submit quotation</LinkButton>
          </div>
        )}
      </header>

      <section aria-labelledby="rfq-lines-heading" className={styles.section}>
        <h2 id="rfq-lines-heading" className={styles.sectionTitle}>
          Items to quote
        </h2>
        {view.lines.length === 0 ? (
          <p className={styles.muted}>No items are listed on this request yet.</p>
        ) : (
          <div className={styles.tableFrame}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Items on {view.number}</caption>
              <thead>
                <tr>
                  <th scope="col">No.</th>
                  <th scope="col">Description</th>
                  <th scope="col">Unit</th>
                  <th scope="col" className={styles.num}>
                    Quantity
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.lines.map((line) => (
                  <tr key={line.lineNo}>
                    <td className={styles.nowrap}>{line.lineNo}</td>
                    <td className={styles.description}>{line.description}</td>
                    <td>{line.uom}</td>
                    <td className={styles.num}>{trimQuantity(line.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
