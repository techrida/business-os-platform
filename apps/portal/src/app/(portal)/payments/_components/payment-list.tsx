import type { PortalDisplay } from '@bos/contracts';

import styles from '@/components/portal/quotation.module.css';
import { Badge } from '@/components/ui/badge';
import type { PortalPaymentListItem } from '@/lib/api.billing';
import { displayFormat } from '@/lib/display';

import { METHOD_LABEL, PAYMENT_STATUS_LOOK } from './payment-status';

/**
 * The customer's own payments as a table: receipt number (once verified), date, method, reference,
 * amount and status. Only the fields of `PortalPaymentListItem` are read, so nothing about who
 * verified a payment or how it was allocated can show. The status is the server's. The table
 * scrolls sideways in its frame on a narrow screen, and a long reference wraps.
 */
export function PaymentList({
  items,
  display,
}: {
  items: readonly PortalPaymentListItem[];
  display?: PortalDisplay;
}) {
  const { money, day: formatDay } = displayFormat(display);
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your payments</caption>
        <thead>
          <tr>
            <th scope="col">Received</th>
            <th scope="col">Receipt</th>
            <th scope="col">Method</th>
            <th scope="col">Reference</th>
            <th scope="col" className={styles.num}>
              Amount
            </th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => {
            const look = PAYMENT_STATUS_LOOK[p.status];
            return (
              <tr key={p.id}>
                <th scope="row" className={styles.nowrap}>
                  {formatDay(p.receivedOn)}
                </th>
                <td className={styles.nowrap}>{p.number ?? '—'}</td>
                <td className={styles.nowrap}>{METHOD_LABEL[p.method]}</td>
                <td className={styles.description}>{p.bankReference ?? '—'}</td>
                <td className={`${styles.num} ${styles.nowrap}`}>{money(p.amount, p.currency)}</td>
                <td>
                  <Badge tone={look.tone}>{look.label}</Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
