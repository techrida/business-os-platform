import type { PaymentRequestStatus } from '@bos/contracts';

import type { BadgeTone } from '../../procurement/orders/_lib/model';

export const PAYMENT_STATUS: Record<PaymentRequestStatus, { text: string; tone: BadgeTone }> = {
  draft: { text: 'Draft', tone: 'neutral' },
  pending_approval: { text: 'Awaiting approval', tone: 'info' },
  approved: { text: 'Approved', tone: 'success' },
  rejected: { text: 'Rejected', tone: 'error' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
};
