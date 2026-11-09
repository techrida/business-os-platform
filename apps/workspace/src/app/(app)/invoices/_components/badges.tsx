import type { InvoiceKind, InvoiceStatus } from '@bos/contracts';

import { Badge } from '@/components/ui/badge';

import { kindMeta, statusMeta } from '../_lib/meta';

/** A status as a badge. The label is always text, so colour is never the only signal. */
export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const { label, tone } = statusMeta(status);
  return <Badge tone={tone}>{label}</Badge>;
}

export function InvoiceKindBadge({ kind }: { kind: InvoiceKind }) {
  const { label, tone } = kindMeta(kind);
  return <Badge tone={tone}>{label}</Badge>;
}
