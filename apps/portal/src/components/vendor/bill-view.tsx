import type { PortalDisplay, VendorPortalBillView } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';
import { displayFormat } from '@/lib/display';

import styles from './vendor.module.css';
import { BILL_STATUS_LOOK } from './vendor-status';

/**
 * One bill as the vendor sees it: the coarse status, the payable total, the TDS amount on their own
 * bill, and each payment made against it (date, amount and bank reference). Every figure is the
 * server's; no balance is worked out in the browser.
 */
export function BillView({
  view,
  display,
}: {
  view: VendorPortalBillView;
  display?: PortalDisplay;
}) {
  const { money: formatAmount, day } = displayFormat(display);
  const look = BILL_STATUS_LOOK[view.status];
  const money = (amount: string) => formatAmount(amount, view.currency);
  return (
    <div className={styles.document}>
      <header className={styles.docHead}>
        <div className={styles.titleRow}>
          <h1 className={styles.docTitle}>{view.number}</h1>
          <Badge tone={look.tone}>{look.label}</Badge>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Your invoice</dt>
            <dd>{view.vendorInvoiceNo}</dd>
          </div>
          <div>
            <dt>Invoice date</dt>
            <dd>{day(view.invoiceDate)}</dd>
          </div>
          <div>
            <dt>TDS withheld</dt>
            <dd>{money(view.tdsAmount)}</dd>
          </div>
          <div>
            <dt>Payable</dt>
            <dd className={styles.factTotal}>{money(view.payableTotal)}</dd>
          </div>
        </dl>
      </header>

      <section aria-labelledby="bill-payments-heading" className={styles.section}>
        <h2 id="bill-payments-heading" className={styles.sectionTitle}>
          Payments
        </h2>
        {view.payments.length === 0 ? (
          <p className={styles.muted}>No payments have been made against this bill yet.</p>
        ) : (
          <div className={styles.tableFrame}>
            <table className={styles.table}>
              <caption className={styles.visuallyHidden}>Payments against {view.number}</caption>
              <thead>
                <tr>
                  <th scope="col">Paid on</th>
                  <th scope="col">Bank reference</th>
                  <th scope="col" className={styles.num}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.payments.map((p) => (
                  <tr key={`${p.paidOn}-${p.reference}`}>
                    <td className={styles.nowrap}>{day(p.paidOn)}</td>
                    <td className={styles.description}>{p.reference}</td>
                    <td className={`${styles.num} ${styles.nowrap}`}>{money(p.amount)}</td>
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
