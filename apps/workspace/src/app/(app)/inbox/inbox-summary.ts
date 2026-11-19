import { documentTypeLabel } from './inbox-params';

export interface InboxSummaryCard {
  key: string;
  label: string;
  value: number;
  icon: 'inbox' | 'file-text';
}

/** At most this many document types get a card of their own. */
const TYPE_CARDS = 3;

/**
 * KPI cards over everything waiting for the caller (the unfiltered inbox read, which has no default limit, so
 * `items` is the whole inbox): the total, then the document types with the most requests. Type cards are left
 * out when there is only one type, since they would repeat the total. An empty inbox has no cards.
 */
export function inboxSummaryCards(items: readonly { documentType: string }[]): InboxSummaryCard[] {
  if (items.length === 0) return [];
  const byType = new Map<string, number>();
  for (const { documentType } of items) {
    byType.set(documentType, (byType.get(documentType) ?? 0) + 1);
  }
  const types =
    byType.size < 2
      ? []
      : [...byType.entries()]
          .map(([type, value]) => ({ type, label: documentTypeLabel(type), value }))
          .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
          .slice(0, TYPE_CARDS);
  return [
    { key: 'waiting', label: 'Waiting for you', value: items.length, icon: 'inbox' },
    ...types.map(({ type, label, value }) => ({
      key: `type:${type}`,
      label,
      value,
      icon: 'file-text' as const,
    })),
  ];
}
