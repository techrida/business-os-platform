import type { QuotationStatus, QuotationStatusHistoryDto, RejectionSource } from '@bos/contracts';
import type { CustomerDateFormat } from '@bos/locale';

import { Panel } from '@/components/ui/panel';
import { when } from '@/lib/kernel-format';

import styles from './detail.module.css';
import { quotationStatusMeta } from './status';

export interface HistoryRow {
  key: string;
  /** "Rev 2", or null for a version the page does not know. */
  revision: string | null;
  title: string;
  /** Who did it, in words. "System" when the change was automatic (expiry, a sweeper). */
  actor: string;
  reason: string | null;
  at: string;
}

/**
 * The event as a sentence, from the two statuses. Only what the history stores is said: the customer's
 * name or the approving team are not in it, so they are not guessed. A pair with no phrase of its own
 * falls back to naming both ends in the badge labels.
 */
export function historyTitle(
  from: QuotationStatus | null,
  to: QuotationStatus,
  rejectionSource: RejectionSource | null = null,
  reason: string | null = null,
): string {
  // A cancelled revision gave this version back (R6D): not a second approval or send. The cancel writes the
  // reason as "Revision N cancelled: ...", which names N.
  if (from === 'superseded' && (to === 'approved' || to === 'sent')) {
    const n = /^Revision (\d+) cancelled/.exec(reason ?? '')?.[1];
    return n === undefined
      ? 'Restored after a revision was cancelled'
      : `Restored after revision ${n} was cancelled`;
  }
  if (from === null)
    return to === 'draft' ? 'Draft created' : `Created as ${quotationStatusMeta(to).label}`;
  if (to === 'submitted')
    return from === 'returned' ? 'Resubmitted for approval' : 'Submitted for approval';
  if (to === 'returned') return 'Returned for changes';
  if (to === 'approved') return 'Approved';
  if (to === 'sent') return 'Sent to the customer';
  if (to === 'accepted') return 'Accepted by the customer';
  if (to === 'rejected') {
    if (rejectionSource === 'customer') return 'Rejected by the customer';
    if (rejectionSource === 'internal') return 'Rejected internally';
    return 'Rejected';
  }
  if (to === 'expired') return 'Expired';
  if (to === 'cancelled') return 'Cancelled';
  if (to === 'superseded') return 'Replaced by a newer revision';
  return `Changed from ${quotationStatusMeta(from).label} to ${quotationStatusMeta(to).label}`;
}

/**
 * Turns the status history into rows for display, newest first. The API does not include names;
 * directory lookups may supply them when the caller has access. `rejectionSource` on a version
 * tells who rejected it.
 */
export function historyRows(
  history: readonly QuotationStatusHistoryDto[],
  versions: readonly { id: string; revisionNo: number; rejectionSource?: RejectionSource | null }[],
  people: ReadonlyMap<string, string> = new Map(),
): HistoryRow[] {
  const revisionOf = new Map(versions.map((v) => [v.id, `Rev ${v.revisionNo}`]));
  const rejectedBy = new Map(versions.map((v) => [v.id, v.rejectionSource ?? null]));
  return history
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byTime = Date.parse(b.entry.at) - Date.parse(a.entry.at);
      // Same instant: the API lists history oldest first, so the later entry is the newer.
      return Number.isNaN(byTime) || byTime === 0 ? b.index - a.index : byTime;
    })
    .map(({ entry, index }) => ({
      key: `${index}-${entry.versionId}-${entry.toStatus}`,
      revision: revisionOf.get(entry.versionId) ?? null,
      title: historyTitle(
        entry.fromStatus,
        entry.toStatus,
        rejectedBy.get(entry.versionId) ?? null,
        entry.reason ?? null,
      ),
      actor:
        entry.actorId === null
          ? 'System'
          : (people.get(entry.actorId) ?? 'Person name unavailable'),
      reason: entry.reason !== null && entry.reason !== '' ? entry.reason : null,
      at: entry.at,
    }));
}

/** Every status change of the quotation across all its revisions, newest first. */
export function StatusHistory({
  history,
  versions,
  people,
  dateFormat,
}: {
  history: readonly QuotationStatusHistoryDto[];
  versions: readonly { id: string; revisionNo: number; rejectionSource?: RejectionSource | null }[];
  people?: ReadonlyMap<string, string>;
  /** The tenant's date pattern (`getDateFormat()`); omitted keeps the default wording. */
  dateFormat?: CustomerDateFormat | undefined;
}) {
  const rows = historyRows(history, versions, people);
  return (
    <Panel title="Status history" className={styles.detailPanel}>
      {rows.length === 0 ? (
        <p className={styles.note}>No status changes yet.</p>
      ) : (
        <ol className={styles.history}>
          {rows.map((row) => (
            <li key={row.key} className={styles.event}>
              <span className={styles.eventName}>{row.title}</span>
              <div className={styles.eventMeta}>
                <time dateTime={row.at}>{when(row.at, 'datetime', dateFormat)}</time>
                <span>{row.actor}</span>
                {row.revision !== null ? <span>{row.revision}</span> : null}
              </div>
              {row.reason !== null ? <p className={styles.reason}>{row.reason}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
