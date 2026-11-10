import type { QuotationStatusHistoryDto } from '@bos/contracts';

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
 * Turns the status history into rows for display, newest first. A change with no earlier status
 * is the creation; every other change names both ends in the same labels the badges use. The API
 * does not include names; directory lookups may supply them when the caller has access.
 */
export function historyRows(
  history: readonly QuotationStatusHistoryDto[],
  versions: readonly { id: string; revisionNo: number }[],
  people: ReadonlyMap<string, string> = new Map(),
): HistoryRow[] {
  const revisionOf = new Map(versions.map((v) => [v.id, `Rev ${v.revisionNo}`]));
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
      title:
        entry.fromStatus === null
          ? `Created as ${quotationStatusMeta(entry.toStatus).label}`
          : `Changed from ${quotationStatusMeta(entry.fromStatus).label} to ${quotationStatusMeta(entry.toStatus).label}`,
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
}: {
  history: readonly QuotationStatusHistoryDto[];
  versions: readonly { id: string; revisionNo: number }[];
  people?: ReadonlyMap<string, string>;
}) {
  const rows = historyRows(history, versions, people);
  return (
    <Panel title="Status history">
      {rows.length === 0 ? (
        <p className={styles.note}>No status changes yet.</p>
      ) : (
        <ol className={styles.history}>
          {rows.map((row) => (
            <li key={row.key} className={styles.event}>
              <div className={styles.eventHead}>
                <span className={styles.eventName}>{row.title}</span>
                {row.revision !== null ? (
                  <span className={styles.eventMeta}>{row.revision}</span>
                ) : null}
                <span className={styles.eventMeta}>{row.actor}</span>
                <time className={styles.eventMeta} dateTime={row.at}>
                  {when(row.at)}
                </time>
              </div>
              {row.reason !== null ? <p className={styles.reason}>{row.reason}</p> : null}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
