import { randomUUID } from 'node:crypto';

import type {
  PaymentPromiseList,
  PaymentPromiseListItem,
  PaymentPromiseRecordBlock,
  PaymentPromiseStatus,
} from '@bos/contracts';
import type { CustomerDateFormat } from '@bos/locale';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { when } from '@/lib/kernel-format';

import { PromiseBlocked, PromiseDialog } from './promise-dialog';
import styles from './promise-card.module.css';

const STATUS: Record<
  Exclude<PaymentPromiseStatus, 'open'>,
  { label: string; tone: 'success' | 'error' | 'neutral' }
> = {
  kept: { label: 'Kept', tone: 'success' },
  missed: { label: 'Missed', tone: 'error' },
  replaced: { label: 'Replaced', tone: 'neutral' },
};

const BLOCKED: Record<PaymentPromiseRecordBlock, string> = {
  no_permission: 'Your roles do not include recording promises to pay.',
  invoice_not_open: 'Nothing is owed on this invoice, so it cannot take a promise to pay.',
};

/** "Recorded by Asha Rai, 12 Nov 2026, 10:30"; a user without a display name stays unnamed. */
function recorded(item: PaymentPromiseListItem, dateFormat: CustomerDateFormat | undefined) {
  const at = when(item.createdAt, 'datetime', dateFormat);
  return item.recordedByName !== null
    ? `Recorded by ${item.recordedByName}, ${at}`
    : `Recorded ${at}`;
}

/**
 * The invoice's promises to pay (F1-Q33): the open one, the history of kept, missed and replaced ones, and Record
 * promise. Whether the caller may record comes from the API's `can`, never from a guess here.
 */
export function PromiseCard({
  invoiceId,
  promises,
  today = todayInKathmandu(),
  dateFormat,
  reloadHref,
}: {
  invoiceId: string;
  promises: PaymentPromiseList;
  /** Today in Kathmandu, the earliest day a customer can promise; the server's clock by default. */
  today?: string;
  dateFormat?: CustomerDateFormat | undefined;
  reloadHref: string;
}) {
  const open = promises.items.find((p) => p.status === 'open');
  const history = promises.items.filter((p) => p.status !== 'open');
  const day = (iso: string) => when(iso, 'date', dateFormat);
  const { can } = promises;

  return (
    <Panel
      as="aside"
      title="Promise to pay"
      actions={
        can.record ? (
          <PromiseDialog
            invoiceId={invoiceId}
            idempotencyKey={randomUUID()}
            today={today}
            replacing={open !== undefined ? day(open.promisedDate) : null}
            reloadHref={reloadHref}
          />
        ) : null
      }
    >
      <div className={styles.body}>
        {open !== undefined ? (
          <div className={styles.current}>
            <p className={styles.date}>Promised for {day(open.promisedDate)}</p>
            {open.note !== null ? <p className={styles.note}>{open.note}</p> : null}
            <p className={styles.meta}>{recorded(open, dateFormat)}</p>
          </div>
        ) : (
          <p className={styles.meta}>No open promise to pay.</p>
        )}
        {!can.record && can.reason !== null ? (
          <PromiseBlocked reason={BLOCKED[can.reason]} />
        ) : null}
        {history.length > 0 ? (
          <section aria-label="Earlier promises">
            <h3 className={styles.heading}>Earlier promises</h3>
            <ul className={styles.history}>
              {history.map((p) => {
                const status = STATUS[p.status as keyof typeof STATUS];
                return (
                  <li key={p.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <span>Promised for {day(p.promisedDate)}</span>
                    </div>
                    {p.note !== null ? <p className={styles.note}>{p.note}</p> : null}
                    <p className={styles.meta}>{recorded(p, dateFormat)}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </Panel>
  );
}
