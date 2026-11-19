import type { QuotationStatus, RejectionSource } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';

import { quotationStatusMeta } from './status';

const REJECTED_BY: Record<RejectionSource, string> = {
  customer: 'Rejected by customer',
  internal: 'Rejected internally',
};

/**
 * A quotation status as a badge. The label is always text and an icon repeats it, so colour is never the only signal.
 * `rejectionSource` (a version knows it, the list does not) widens "Rejected" to say who said no;
 * it is ignored for every other status.
 */
export function QuotationStatusBadge({
  status,
  rejectionSource,
}: {
  status: QuotationStatus;
  rejectionSource?: RejectionSource | null;
}) {
  const { label, tone, icon } = quotationStatusMeta(status);
  const text =
    status === 'rejected' && rejectionSource != null ? REJECTED_BY[rejectionSource] : label;
  return (
    <Badge tone={tone}>
      <Icon name={icon} size={12} />
      {text}
    </Badge>
  );
}
