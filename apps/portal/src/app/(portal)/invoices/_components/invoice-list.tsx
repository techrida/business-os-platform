import type { PortalDisplay, PortalInvoiceListItem } from '@bos/contracts';

import styles from '@/components/portal/quotation.module.css';
import { displayFormat } from '@/lib/display';

import { KIND_LABEL } from './invoice-status';

/**
 * The customer's issued invoices and notes as a table: number, type, issue and due dates, total and
 * the amount still open. Only the fields of `PortalInvoiceListItem` are read. The open amount is the
 * server's figure; the status word lives on the invoice page, where the server sends it. The number
 * is a plain link (no prefetch), and the table scrolls sideways in its frame on a narrow screen.
 */
export function InvoiceList({
  items,
  display,
}: {
  items: readonly PortalInvoiceListItem[];
  display?: PortalDisplay;
}) {
  const { money, day: formatDay } = displayFormat(display);
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your invoices</caption>
        <thead>
          <tr>
            <th scope="col">Invoice</th>
            <th scope="col">Type</th>
            <th scope="col">Issued</th>
            <th scope="col">Due</th>
            <th scope="col" className={styles.num}>
              Total
            </th>
            <th scope="col" className={styles.num}>
              Open amount
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((inv) => (
            <tr key={inv.id}>
              <th scope="row">
                <a className={styles.rowLink} href={`/invoices/${inv.id}`}>
                  {inv.number}
                </a>
              </th>
              <td className={styles.nowrap}>{KIND_LABEL[inv.kind]}</td>
              <td className={styles.nowrap}>{formatDay(inv.issueDate)}</td>
              <td className={styles.nowrap}>{inv.dueDate ? formatDay(inv.dueDate) : '—'}</td>
              <td className={`${styles.num} ${styles.nowrap}`}>{money(inv.total, inv.currency)}</td>
              <td className={`${styles.num} ${styles.nowrap}`}>
                {money(inv.openAmount, inv.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
