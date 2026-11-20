import type { PaymentRequestStatus } from '@bos/contracts';

import type { PaymentRequestItem } from '@/lib/api-payables';

import type { BadgeTone } from '../../procurement/orders/_lib/model';

export const PAYMENT_STATUS: Record<PaymentRequestStatus, { text: string; tone: BadgeTone }> = {
  draft: { text: 'Draft', tone: 'neutral' },
  pending_approval: { text: 'Awaiting approval', tone: 'info' },
  approved: { text: 'Approved', tone: 'success' },
  rejected: { text: 'Rejected', tone: 'error' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
};

/**
 * A request's name: its number, else words that follow its status. Requests are not numbered yet, so a submitted,
 * approved or rejected one must not still read as a draft.
 */
export function requestTitle(request: {
  number: string | null;
  status: PaymentRequestStatus;
}): string {
  return (
    request.number ?? (request.status === 'draft' ? 'Draft payment request' : 'Payment request')
  );
}

/** The new request page's heading: drawn by the page, or by the entry form when it holds the actions. */
export const NEW_REQUEST_HEADING = {
  title: 'New payment request',
  description:
    'Settle approved bills for one vendor and one currency. The platform supplies the total and verified destination account.',
};

/**
 * The approved bill item a payment request can start from: the bill's balance still free to claim (after pending
 * and approved requests, as the server worked it out), in a currency the company has switched on. Anything else
 * would open a form that cannot use it, so no "Request payment" link points there.
 */
export function requestableItem(
  items: readonly PaymentRequestItem[],
  billId: string,
  enabledCurrencies: readonly string[],
): PaymentRequestItem | undefined {
  return items.find(
    (item) =>
      item.vendorBillId === billId &&
      Number(item.availableAmount) > 0 &&
      enabledCurrencies.includes(item.currency),
  );
}
