import { trimPercent, type PortalDisplay, type PortalSalesOrder } from '@bos/contracts';

import styles from '@/components/portal/quotation.module.css';
import { Badge } from '@/components/ui/badge';
import { displayFormat } from '@/lib/display';

import { MILESTONE_LOOK } from './milestone-status';

/**
 * One order's milestones (its billing schedule, F1-Q34) as a table: the milestone, its share, its amount, the planned
 * date, the status and, once invoiced, the invoice with its due date. Only the fields of `PortalMilestone` are read;
 * the amounts are the server's figures, never recomputed (D36).
 */
export function MilestoneTable({
  order,
  display,
}: {
  order: PortalSalesOrder;
  display?: PortalDisplay;
}) {
  const { money, day } = displayFormat(display);
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Milestones of order {order.number}</caption>
        <thead>
          <tr>
            <th scope="col">Milestone</th>
            <th scope="col" className={styles.num}>
              Share
            </th>
            <th scope="col" className={styles.num}>
              Amount
            </th>
            <th scope="col">Planned</th>
            <th scope="col">Status</th>
            <th scope="col">Invoice</th>
          </tr>
        </thead>
        <tbody>
          {order.milestones.map((m) => {
            const look = MILESTONE_LOOK[m.status];
            return (
              <tr key={m.seq}>
                <th scope="row">{m.label}</th>
                <td className={`${styles.num} ${styles.nowrap}`}>
                  {m.percent === null ? '—' : `${trimPercent(m.percent)}%`}
                </td>
                <td className={`${styles.num} ${styles.nowrap}`}>
                  {money(m.amount, order.currency)}
                </td>
                <td className={styles.nowrap}>{m.plannedDate ? day(m.plannedDate) : '—'}</td>
                <td>
                  <Badge tone={look.tone}>{look.label}</Badge>
                </td>
                <td className={styles.nowrap}>
                  {m.invoice ? (
                    <>
                      <a className={styles.rowLink} href={`/invoices/${m.invoice.id}`}>
                        {m.invoice.number}
                      </a>
                      {m.invoice.dueDate ? ` · due ${day(m.invoice.dueDate)}` : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
