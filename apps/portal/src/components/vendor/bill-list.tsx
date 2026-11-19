import { formatCustomerDate } from '@bos/locale';
import type { VendorPortalBillView } from '@bos/contracts';
import { formatMoney } from '@bos/locale';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

import styles from './vendor.module.css';
import { BILL_STATUS_LOOK } from './vendor-status';

/** The vendor's bills: our number, their invoice number, date, coarse status and the payable total. */
export function BillList({ items }: { items: readonly VendorPortalBillView[] }) {
  if (items.length === 0) {
    return (
      <EmptyState title="No bills yet" icon="receipt">
        Bills we have received from you will be listed here, with where each one stands.
      </EmptyState>
    );
  }
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your bills</caption>
        <thead>
          <tr>
            <th scope="col">Bill</th>
            <th scope="col">Your invoice</th>
            <th scope="col">Invoice date</th>
            <th scope="col">Status</th>
            <th scope="col" className={styles.num}>
              Payable
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((bill) => {
            const look = BILL_STATUS_LOOK[bill.status];
            return (
              <tr key={bill.id}>
                <th scope="row">
                  <a className={styles.rowLink} href={`/vendor/bills/${bill.id}`}>
                    {bill.number}
                  </a>
                </th>
                <td className={styles.description}>{bill.vendorInvoiceNo}</td>
                <td className={styles.nowrap}>{formatCustomerDate(bill.invoiceDate)}</td>
                <td>
                  <Badge tone={look.tone}>{look.label}</Badge>
                </td>
                <td className={`${styles.num} ${styles.nowrap}`}>
                  {formatMoney(bill.payableTotal, bill.currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
