import type { VendorPortalRfqListItem } from '@bos/contracts';
import { formatKathmandu } from '@bos/locale';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

import styles from './vendor.module.css';

/**
 * True once the deadline instant has gone by, the same rule the API applies (F1-Q47): a quotation
 * sent strictly after the deadline is refused, so the screens stop offering to send one.
 */
export const isPastDeadline = (deadline: string, now: Date): boolean =>
  new Date(deadline).getTime() < now.getTime();

/** The deadline in Kathmandu time, e.g. `20 Nov 2026, 14:00`. */
export const formatDeadline = (deadline: string): string =>
  formatKathmandu(new Date(deadline), 'datetime');

/**
 * The requests for quotation the vendor is invited to: number, deadline in Nepal time and whether
 * the deadline is still ahead, each number a plain link (no prefetch). The table scrolls inside
 * its frame on a narrow screen. `now` comes from the page so the markup is a pure function of it.
 */
export function RfqList({ items, now }: { items: readonly VendorPortalRfqListItem[]; now: Date }) {
  if (items.length === 0) {
    return (
      <EmptyState title="No requests for quotation yet" icon="file-text">
        When we invite you to quote on something, the request will be listed here.
      </EmptyState>
    );
  }
  return (
    <div className={styles.tableFrame}>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Your requests for quotation</caption>
        <thead>
          <tr>
            <th scope="col">Request</th>
            <th scope="col">Quotations close (Nepal time)</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((rfq) => (
            <tr key={rfq.id}>
              <th scope="row">
                <a className={styles.rowLink} href={`/vendor/rfqs/${rfq.id}`}>
                  {rfq.number}
                </a>
              </th>
              <td className={styles.nowrap}>{formatDeadline(rfq.deadline)}</td>
              <td>
                {isPastDeadline(rfq.deadline, now) ? (
                  <Badge tone="warning">Deadline passed</Badge>
                ) : (
                  <Badge tone="info">Open for quotations</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
