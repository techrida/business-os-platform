// The lock order of every money command (P3 plan, section 2 "Money commands", step 3):
//   sales order -> schedule lines -> payment -> invoices / open items (ascending id) -> number_series (last).
// Two commands that lock the same rows in the same order wait for each other instead of deadlocking. Pure: the
// service turns a plan into SELECT ... ORDER BY id FOR UPDATE statements, one table per step.

/**
 * Ranks in the order they must be locked. The plan puts invoices and open items in one step "by ascending id";
 * they are two tables, so they are two ranks here (invoices first), each locked in ascending id order.
 * number_series is listed so the order is complete, but only NumberingService.issue locks it (last).
 */
export const LOCK_RANKS = [
  'sales_order',
  'schedule_line',
  'payment',
  'invoice',
  'open_item',
  'number_series',
] as const;

export type LockRank = (typeof LOCK_RANKS)[number];

export interface LockStep {
  rank: LockRank;
  ids: readonly string[];
}

/** A programming error: the command asked for locks in an order that can deadlock against another command. */
export class LockOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockOrderError';
  }
}

/**
 * Ids ascending and without duplicates, in the order Postgres sorts the uuid type: bytewise, which for the
 * canonical text form is lowercase hex compared as a string.
 */
export function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Checks that the steps follow LOCK_RANKS strictly (each rank at most once) and returns them with their ids
 * sorted. A step with no ids is dropped. Throws LockOrderError on a step out of order, a repeated rank, or
 * number_series.
 */
export function planLocks(steps: readonly LockStep[]): LockStep[] {
  let previous = -1;
  const plan: LockStep[] = [];
  for (const step of steps) {
    if (step.rank === 'number_series') {
      throw new LockOrderError('number_series is locked by NumberingService.issue, last; do not lock it here');
    }
    const rank = LOCK_RANKS.indexOf(step.rank);
    if (rank <= previous) {
      throw new LockOrderError(
        `lock order: ${step.rank} cannot follow ${LOCK_RANKS[previous] ?? 'nothing'} (order: ${LOCK_RANKS.join(' -> ')})`,
      );
    }
    previous = rank;
    const ids = sortedIds(step.ids);
    if (ids.length > 0) plan.push({ rank: step.rank, ids });
  }
  return plan;
}
