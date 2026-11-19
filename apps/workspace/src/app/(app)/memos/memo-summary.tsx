import { MEMO_STATUSES } from '@bos/contracts';

import { StatCard } from '@/components/ui/stat-card';
import { listMemos } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { memoSummaryCards } from '@/lib/memo-list-view';

import pageStyles from './memo-pages.module.css';

/**
 * Counts over the memos this person may open, one tiny read per status (`limit=1`, only `total` is used).
 * The reads go through the same scoped list endpoint as the table, so a role sees only its own counts. If
 * any read fails the cards are left out: a missing figure is better than a zero that is not true.
 */
export async function MemoSummary() {
  const session = await requireStaffSession('/memos');
  const reads = await Promise.allSettled(
    MEMO_STATUSES.map((status) => listMemos(session, { limit: 1, status: [status] })),
  );
  const counts: Record<string, number> = {};
  for (const [index, read] of reads.entries()) {
    if (read.status !== 'fulfilled') return null;
    counts[MEMO_STATUSES[index] as string] = read.value.total;
  }
  return (
    <section className={pageStyles.stats} aria-label="Memo summary">
      {memoSummaryCards(counts).map((card) => (
        <StatCard
          key={card.key}
          label={card.label}
          value={card.value}
          icon={card.icon}
          tone={card.tone}
        />
      ))}
    </section>
  );
}
