import {
  RequestPaymentBodySchema,
  type Currency,
  type PaymentRequestStatus,
  type RequestPaymentBody,
} from '@bos/contracts';
import { Dec, formatKathmandu, postedAmount } from '@bos/locale';

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

/** Most payable items one request takes, as the contract allows. */
export const MAX_REQUEST_ITEMS = 200;

/**
 * The request the entry form posts, read the same way by the create action and by the review step, so what the
 * review shows is what the action sends. `lineCount` is null when the count is not a whole number from 1 to 200.
 */
export function readPaymentRequestForm(form: FormData): {
  lineCount: number | null;
  allocations: { openItemId: string; amount: string }[];
  body: Record<string, unknown>;
} {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const count = Number(text('lineCount'));
  const lineCount =
    Number.isInteger(count) && count >= 1 && count <= MAX_REQUEST_ITEMS ? count : null;
  const allocations = Array.from({ length: lineCount ?? 0 }, (_, i) => ({
    openItemId: text(`allocation:${i}:openItemId`),
    // The text a hydrated box posts, so grouped or padded text from before hydration reads the same.
    amount: postedAmount(text(`allocation:${i}:amount`)),
  }));
  const purchaseOrderId = text('purchaseOrderId');
  return {
    lineCount,
    allocations,
    body: {
      vendorPartyId: text('vendorPartyId'),
      fromBankAccountId: text('fromBankAccountId'),
      currency: text('currency'),
      paymentType: 'settlement',
      ...(purchaseOrderId === '' ? {} : { purchaseOrderId }),
      allocations,
    },
  };
}

/** What the review step shows before a payment request is created: names, not ids. */
export interface PaymentRequestReview {
  payee: string;
  payFrom: string;
  /** The purchase order's label, or null when the request names none. */
  purchaseOrder: string | null;
  currency: Currency;
  /** The sum of the lines, as a plain decimal string. */
  total: string;
  lines: { reference: string; amount: string }[];
  /** The Kathmandu calendar day the request is created on, e.g. `22 Nov 2026`. */
  requestDate: string;
}

/**
 * The review of a filled-in entry form, or null when the request is not complete enough to send (the contract
 * refuses it). The names come from the lists the form offered; an id the lists do not know shows as "Unknown".
 */
export function reviewPaymentRequest(
  form: FormData,
  names: {
    vendor: (id: string) => string | undefined;
    bankAccount: (id: string) => string | undefined;
    purchaseOrder: (id: string) => string | undefined;
    bill: (openItemId: string) => string | undefined;
  },
  now: Date = new Date(),
): PaymentRequestReview | null {
  const read = readPaymentRequestForm(form);
  if (read.lineCount === null) return null;
  const parsed = RequestPaymentBodySchema.safeParse(read.body);
  if (!parsed.success) return null;
  const body: RequestPaymentBody = parsed.data;
  const total = body.allocations.reduce((sum, line) => sum.plus(line.amount), new Dec(0));
  return {
    payee: names.vendor(body.vendorPartyId) ?? 'Unknown vendor',
    payFrom: names.bankAccount(body.fromBankAccountId) ?? 'Unknown account',
    purchaseOrder:
      body.purchaseOrderId === undefined
        ? null
        : (names.purchaseOrder(body.purchaseOrderId) ?? 'Unknown purchase order'),
    currency: body.currency,
    total: total.toFixed(),
    lines: body.allocations.map((line) => ({
      reference: names.bill(line.openItemId) ?? 'Unknown bill',
      amount: line.amount,
    })),
    requestDate: formatKathmandu(now, 'date'),
  };
}
