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
 * and approved requests, as the server worked it out). Any currency counts, switched off in Settings or not: a bill
 * already owed must stay payable, so payment requests are exempt from the switch-off (D56 U16-Q1).
 */
export function requestableItem(
  items: readonly PaymentRequestItem[],
  billId: string,
): PaymentRequestItem | undefined {
  return items.find((item) => item.vendorBillId === billId && Number(item.availableAmount) > 0);
}

/**
 * What to do when a vendor has no verified bank account, worded for what the reader may do (live
 * `vendor.bank.propose`): the same people and order the vendor page describes.
 */
export function addBankAccountText(mayPropose: boolean): string {
  return mayPropose
    ? 'Propose a bank account on the vendor’s page. Someone other than the proposer verifies it after a call-back to the bank, and then the bill can be requested.'
    : 'Procurement proposes an account on the vendor’s page; finance verifies it after a call-back to the bank. Then the bill can be requested.';
}

/** The vendors, by name and in first-seen order, of the items held back for a missing verified bank account. */
export function vendorsWithoutBankAccount(
  held: readonly PaymentRequestItem[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const item of held) {
    if (!seen.has(item.vendorPartyId)) seen.set(item.vendorPartyId, item.vendorName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}
