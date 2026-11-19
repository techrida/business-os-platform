import type { BillStatus, PaymentRequestStatus } from '@bos/contracts';

import type { IconName } from '@/components/ui/icon';

type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

/** One stat card: the statuses it counts (none means every status). */
export interface CountCard<S extends string> {
  key: string;
  label: string;
  icon: IconName;
  tone: Tone;
  statuses: readonly S[];
}

export const BILL_COUNT_CARDS: readonly CountCard<BillStatus>[] = [
  { key: 'all', label: 'All bills', icon: 'receipt', tone: 'info', statuses: [] },
  {
    key: 'variance',
    label: 'Outside tolerance',
    icon: 'alert-triangle',
    tone: 'warning',
    statuses: ['variance', 'exception_pending'],
  },
  {
    key: 'approval',
    label: 'Awaiting approval',
    icon: 'list-checks',
    tone: 'info',
    statuses: ['pending_approval'],
  },
  {
    key: 'ready',
    label: 'Approved to pay',
    icon: 'check-circle',
    tone: 'success',
    statuses: ['approved', 'partially_paid'],
  },
  { key: 'paid', label: 'Paid', icon: 'banknote', tone: 'success', statuses: ['paid'] },
];

export const PAYMENT_REQUEST_COUNT_CARDS: readonly CountCard<PaymentRequestStatus>[] = [
  { key: 'all', label: 'All requests', icon: 'banknote', tone: 'info', statuses: [] },
  { key: 'draft', label: 'Drafts', icon: 'file-text', tone: 'neutral', statuses: ['draft'] },
  {
    key: 'approval',
    label: 'Awaiting approval',
    icon: 'list-checks',
    tone: 'warning',
    statuses: ['pending_approval'],
  },
  {
    key: 'approved',
    label: 'Approved',
    icon: 'check-circle',
    tone: 'success',
    statuses: ['approved'],
  },
  { key: 'rejected', label: 'Rejected', icon: 'x-circle', tone: 'error', statuses: ['rejected'] },
];

/**
 * Counts for the stat cards, one tiny read per card through the list's own scoped endpoint (`limit=1`; only the
 * total is used), so a role sees only the counts of what it may open. If any read fails the cards are left out:
 * a missing figure is better than a zero that is not true.
 */
export async function countCards<S extends string>(
  cards: readonly CountCard<S>[],
  total: (statuses: readonly S[]) => Promise<number>,
): Promise<(Omit<CountCard<S>, 'statuses'> & { value: number })[] | null> {
  const reads = await Promise.allSettled(cards.map((card) => total(card.statuses)));
  const values: number[] = [];
  for (const read of reads) {
    if (read.status !== 'fulfilled') return null;
    values.push(read.value);
  }
  return cards.map(({ statuses: _statuses, ...card }, i) => ({ ...card, value: values[i] ?? 0 }));
}
