import { documentTypeLabel } from './inbox-params';

export interface InboxSummaryCard {
  key: string;
  label: string;
  value: number;
  icon: 'inbox' | 'file-text';
}

/** At most this many document types get a card of their own. */
const TYPE_CARDS = 3;

export function inboxSummaryCards(
  buckets: readonly { documentType: string; count: number }[],
): InboxSummaryCard[] {
  if (buckets.length === 0) return [];
  const byType = new Map<string, number>();
  let total = 0;
  for (const { documentType, count } of buckets) {
    byType.set(documentType, (byType.get(documentType) ?? 0) + count);
    total += count;
  }
  const types =
    byType.size < 2
      ? []
      : [...byType.entries()]
          .map(([type, value]) => ({ type, label: documentTypeLabel(type), value }))
          .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
          .slice(0, TYPE_CARDS);
  return [
    { key: 'waiting', label: 'Waiting for you', value: total, icon: 'inbox' },
    ...types.map(({ type, label, value }) => ({
      key: `type:${type}`,
      label,
      value,
      icon: 'file-text' as const,
    })),
  ];
}
