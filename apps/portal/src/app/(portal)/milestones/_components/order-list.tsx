import type { PortalDisplay, PortalSalesOrder } from '@bos/contracts';

import styles from '@/components/portal/quotation.module.css';
import { todayInKathmandu } from '@/components/portal/quotation-status';
import { displayFormat } from '@/lib/display';

import { invoicedCount } from './milestone-status';

/**
 * The customer's confirmed orders as a table: the order number (a plain link to its milestones), when it was
 * confirmed, its total and how many of its milestones are invoiced.
 */
export function OrderList({
  items,
  display,
}: {
  items: readonly PortalSalesOrder[];
  display?: PortalDisplay;
}) {
  const { money, day } = displayFormat(display);
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your orders</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Confirmed</th>
            <th scope="col" className={styles.num}>
              Total
            </th>
            <th scope="col">Milestones</th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.id}>
              <th scope="row">
                <a className={styles.rowLink} href={`/milestones/${o.id}`}>
                  {o.number}
                </a>
              </th>
              <td className={styles.nowrap}>
                {/* The Kathmandu calendar day of the confirmation, as every portal date is. */}
                {o.confirmedAt ? day(todayInKathmandu(new Date(o.confirmedAt))) : '—'}
              </td>
              <td className={`${styles.num} ${styles.nowrap}`}>{money(o.total, o.currency)}</td>
              <td className={styles.nowrap}>{invoicedCount(o.milestones)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
