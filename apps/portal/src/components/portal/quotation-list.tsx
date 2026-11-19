import type { PortalDisplay, PortalQuotationListItem } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';
import { displayFormat } from '@/lib/display';

import styles from './quotation.module.css';
import { displayStatus, STATUS_LOOK } from './quotation-status';

/**
 * The customer's quotations as a table: number, status, total and valid-until. Only the fields of
 * `PortalQuotationListItem` are read. The number is a plain link (no prefetch), and the table
 * scrolls sideways inside its frame on a narrow screen instead of squeezing the columns.
 */
export function QuotationList({
  items,
  today,
  display,
}: {
  items: readonly PortalQuotationListItem[];
  today: string;
  display?: PortalDisplay;
}) {
  const { money, day: formatDay } = displayFormat(display);
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your quotations</caption>
        <thead>
          <tr>
            <th scope="col">Quotation</th>
            <th scope="col">Status</th>
            <th scope="col">Issued</th>
            <th scope="col">Valid until</th>
            <th scope="col" className={styles.num}>
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((q) => {
            const look = STATUS_LOOK[displayStatus(q.status, q.validUntil, today)];
            return (
              <tr key={q.id}>
                <th scope="row">
                  <a className={styles.rowLink} href={`/quotations/${q.id}`}>
                    {q.number}
                    <span className={styles.revision}> Rev {q.revisionNo}</span>
                  </a>
                </th>
                <td>
                  <Badge tone={look.tone}>{look.label}</Badge>
                </td>
                <td className={styles.nowrap}>{formatDay(q.issueDate)}</td>
                <td className={styles.nowrap}>{formatDay(q.validUntil)}</td>
                <td className={`${styles.num} ${styles.nowrap}`}>{money(q.total, q.currency)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
