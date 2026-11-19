import { formatCustomerDate } from '@bos/locale';
import type { VendorPortalPurchaseOrderListItem } from '@bos/contracts';
import { formatMoney } from '@bos/locale';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

import styles from './vendor.module.css';
import { PO_STATUS_LOOK } from './vendor-status';

/**
 * The vendor's purchase orders: number, version, status, date and total, each number a plain link
 * (no prefetch). The table scrolls inside its frame on a narrow screen.
 */
export function PurchaseOrderList({
  items,
}: {
  items: readonly VendorPortalPurchaseOrderListItem[];
}) {
  if (items.length === 0) {
    return (
      <EmptyState title="No purchase orders yet" icon="file-text">
        When we send you a purchase order, it will be listed here.
      </EmptyState>
    );
  }
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your purchase orders</caption>
        <thead>
          <tr>
            <th scope="col">Purchase order</th>
            <th scope="col">Status</th>
            <th scope="col">Issued</th>
            <th scope="col" className={styles.num}>
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((po) => {
            const look = PO_STATUS_LOOK[po.status];
            return (
              <tr key={po.id}>
                <th scope="row">
                  <a className={styles.rowLink} href={`/vendor/purchase-orders/${po.id}`}>
                    {po.number}
                    <span className={styles.version}> Version {po.version}</span>
                  </a>
                </th>
                <td>
                  <Badge tone={look.tone}>{look.label}</Badge>
                </td>
                <td className={styles.nowrap}>{formatCustomerDate(po.issueDate)}</td>
                <td className={`${styles.num} ${styles.nowrap}`}>
                  {formatMoney(po.total, po.currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
