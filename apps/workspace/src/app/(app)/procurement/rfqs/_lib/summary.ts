import type { PoStatus, RfqStatus } from '@bos/contracts';

import type { IconName } from '@/components/ui/icon';

export interface SummaryCard {
  key: string;
  label: string;
  icon: IconName;
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  value: number;
}

/** One stat card: the list's own total for a set of statuses (none means every status). */
export type SummarySpec<S extends string> = Omit<SummaryCard, 'value'> & { status: S[] };

export const RFQ_SUMMARY: readonly SummarySpec<RfqStatus>[] = [
  { key: 'all', label: 'Total RFQs', icon: 'file-text', tone: 'info', status: [] },
  { key: 'open', label: 'Open for quotations', icon: 'mail', tone: 'info', status: ['open'] },
  {
    key: 'closed',
    label: 'Waiting for a recommendation',
    icon: 'list-checks',
    tone: 'warning',
    status: ['closed'],
  },
  {
    key: 'recommended',
    label: 'Recommended',
    icon: 'check-circle',
    tone: 'success',
    status: ['recommended'],
  },
];

export const PO_SUMMARY: readonly SummarySpec<PoStatus>[] = [
  { key: 'all', label: 'Total purchase orders', icon: 'file-text', tone: 'info', status: [] },
  {
    key: 'draft',
    label: 'Drafts to issue',
    icon: 'list-checks',
    tone: 'neutral',
    status: ['draft'],
  },
  {
    key: 'receiving',
    label: 'Waiting for delivery',
    icon: 'receipt',
    tone: 'warning',
    status: ['issued', 'partially_received'],
  },
  {
    key: 'amendment',
    label: 'Amendments pending',
    icon: 'alert-triangle',
    tone: 'warning',
    status: ['amendment_pending'],
  },
];

/**
 * Counts over the records this person may open, one tiny read per card (`limit=1`, only `total`
 * is used) through the same scoped list endpoint as the table, so a role sees only its own counts.
 * If any read fails the cards are left out: a missing figure is better than a zero that is not true.
 */
export async function summaryCards<S extends string>(
  specs: readonly SummarySpec<S>[],
  read: (status: S[]) => Promise<{ total: number }>,
): Promise<SummaryCard[] | null> {
  const reads = await Promise.allSettled(specs.map((spec) => read(spec.status)));
  const cards: SummaryCard[] = [];
  for (const [index, result] of reads.entries()) {
    const spec = specs[index];
    if (result.status !== 'fulfilled' || spec === undefined) return null;
    const { key, label, icon, tone } = spec;
    cards.push({ key, label, icon, tone, value: result.value.total });
  }
  return cards;
}
