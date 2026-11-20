import type { InvoiceListItem, SettlementStatus } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';

import type { Tone } from '../_lib/meta';
import { InvoiceStatusBadge } from './badges';

/** One word each, for the list's Status column. Typed as a full record so a new state needs words here. */
const SETTLEMENT_WORD: Record<SettlementStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'warning' },
  partly_paid: { label: 'Partial', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'error' },
  credited: { label: 'Credited', tone: 'neutral' },
};

/**
 * The list's Status column: an issued tax invoice or debit note shows where its payment stands (Paid, Overdue and
 * the rest, from the server's derived settlement); everything else shows its approval status.
 */
export function ListStatusBadge({
  item,
}: {
  item: Pick<InvoiceListItem, 'status' | 'settlement'>;
}) {
  if (item.settlement != null) {
    const { label, tone } = SETTLEMENT_WORD[item.settlement];
    return <Badge tone={tone}>{label}</Badge>;
  }
  return <InvoiceStatusBadge status={item.status} />;
}
