// Pure rules of payment requests (P4 unit A2; AD1, AD4, AD5, AD8): the `payment_request` workflow spec, the approval
// facts, the line checks and the status moves. No I/O, so every rule is cheap to table-test.
// Serves the NFRs "amounts are exact" (decimal.js strings, ROUND_HALF_UP; NPR per line at its bill's rate) and "money
// moves only after the right people agree" (a request routes Finance, plus the AD4 bands unless every bill was
// matched against its PO; the requester, the bills' enterers and the bills' approvers never approve it).
import {
  PaymentRequestStatusSchema,
  canTransitionPaymentRequest,
  limitOffset,
  multi,
  searchParam,
  type PaymentRequestStatus,
} from '@bos/contracts';
import { parseDecimal, roundMoney } from '@bos/money-rules';
import Decimal from 'decimal.js';
import { z } from 'zod';

/** approval_requests.document_type of a payment request; the document id is the request id. */
export const PAYMENT_REQUEST_DOCUMENT_TYPE = 'payment_request';

/** The audit entity type of the module's domain events. */
export const PAYMENT_REQUEST_AUDIT_ENTITY = 'payment_requests';

/** Bill statuses whose payable open item may be asked for: posted and not fully settled or voided. */
export const PAYABLE_BILL_STATUSES = ['approved', 'partially_paid'] as const;

/** Request statuses that hold a claim on an open item's balance (the claim ends at rejected or cancelled). */
export const CLAIMING_REQUEST_STATUSES = ['pending_approval', 'approved'] as const;

/**
 * The workflow the seed unit publishes for `payment_request` (v1). AD5: a request whose lines are all on bills
 * matched against their PO needs Finance only. Otherwise AD4 adds Management above NPR 100,000.00 and Founder above
 * NPR 1,000,000.00 (strict >, on the request total in NPR); AD8: when the requester is the Founder, a second,
 * distinct Management step replaces the Founder step. distinctApprovers makes the two Management steps two people.
 * Kept here as the one copy the tests and the hand-back quote; the seed copies it word for word.
 */
export const PAYMENT_REQUEST_WORKFLOW_SPEC: unknown = {
  documentType: PAYMENT_REQUEST_DOCUMENT_TYPE,
  steps: [
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance approves the payment',
    },
  ],
  rules: [
    {
      id: 'management',
      when: {
        all: [
          { field: 'allPoMatched', op: 'eq', value: false },
          { field: 'amountNpr', op: 'gt', value: '100000.00' },
        ],
      },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because a payment not fully PO-matched exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Payment of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'allPoMatched', op: 'eq', value: false },
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: false },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because a payment not fully PO-matched exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Payment of NPR {amountNpr} is above NPR 1,000,000.00',
    },
    {
      id: 'management_second',
      when: {
        all: [
          { field: 'allPoMatched', op: 'eq', value: false },
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management_second',
        kind: 'role',
        role: 'management',
        reason: 'A second Management approval replaces the Founder, who raised this payment (AD8)',
      },
      position: 'end',
      reason: 'The Founder raised a payment of NPR {amountNpr}, above NPR 1,000,000.00',
    },
  ],
  distinctApprovers: true,
};

// ------------------------------------------------------------------------------------------------- facts

export interface PaymentRequestFacts extends Record<string, unknown> {
  /** The request total in NPR (each line at its bill's FX rate), as a numeric(18,2) string. */
  amountNpr: string;
  /** Every line is on a bill matched against its PO (match_status `matched`; an accepted variance is not). */
  allPoMatched: boolean;
  requesterIsFounder: boolean;
}

/** NPR of the lines: each line's amount x its bill's FX rate, rounded to paisa, summed. */
export function amountNprOf(lines: readonly { amount: string; fxRate: string }[]): string {
  return lines
    .reduce(
      (acc, l) => acc.plus(roundMoney(parseDecimal(l.amount).times(parseDecimal(l.fxRate)))),
      new Decimal(0),
    )
    .toFixed(2);
}

/**
 * AD5: a bill counts as PO-matched when it names a PO and its latest match run is within tolerance. A bill that
 * went through only because Finance accepted a variance (exception_approved) is not matched, so the bands apply.
 */
export function allPoMatchedOf(
  bills: readonly { purchaseOrderId: string | null; matchStatus: string }[],
): boolean {
  return (
    bills.length > 0 &&
    bills.every((b) => b.purchaseOrderId !== null && b.matchStatus === 'matched')
  );
}

export function paymentRequestFactsOf(i: PaymentRequestFacts): PaymentRequestFacts {
  return {
    amountNpr: i.amountNpr,
    allPoMatched: i.allPoMatched,
    requesterIsFounder: i.requesterIsFounder,
  };
}

/**
 * Check 4: who may not approve the request. The requester, whoever pressed submit, each bill's enterer and each
 * person who approved one of the bills (or on whose behalf a delegate approved), once each.
 */
export function separatedUsers(i: {
  requester: string;
  submitter: string;
  billEnterers: readonly string[];
  billApprovers: readonly (string | null)[];
}): string[] {
  return [
    ...new Set(
      [i.requester, i.submitter, ...i.billEnterers, ...i.billApprovers].filter(
        (id): id is string => id !== null && id !== '',
      ),
    ),
  ];
}

// ------------------------------------------------------------------------------------------------- lines

/** A line may ask for at most what is still open on its item after the other live requests' claims. */
export function exceedsOpen(amount: string, openAmount: string, claimed = '0'): boolean {
  return parseDecimal(amount).gt(parseDecimal(openAmount).minus(parseDecimal(claimed)));
}

/** The first open item named twice, if any (payment_request_lines is unique per request and item). */
export function repeatedOpenItem(lines: readonly { openItemId: string }[]): string | undefined {
  const seen = new Set<string>();
  for (const l of lines) {
    const id = l.openItemId.toLowerCase();
    if (seen.has(id)) return l.openItemId;
    seen.add(id);
  }
  return undefined;
}

export function totalOf(lines: readonly { amount: string }[]): string {
  return lines.reduce((acc, l) => acc.plus(parseDecimal(l.amount)), new Decimal(0)).toFixed(2);
}

// ------------------------------------------------------------------------------------------------- status

/**
 * Only a draft may be cancelled. The contract table also allows approved -> cancelled, but AD1 makes `approved`
 * terminal in Stage 1 (no payout to call off), so this unit refuses it.
 */
export function canCancel(status: PaymentRequestStatus): boolean {
  return status === 'draft' && canTransitionPaymentRequest(status, 'cancelled');
}

/**
 * Where a decision takes a pending request. PAYMENT_REQUEST_TRANSITIONS has no pending_approval -> draft move, so a
 * returned request ends as rejected (raise a new one), like a rejected one.
 */
export function statusAfter(outcome: 'approved' | 'returned' | 'rejected'): PaymentRequestStatus {
  return outcome === 'approved' ? 'approved' : 'rejected';
}

/** Body of POST /v1/payables/payment-requests/:id/cancel; the reason is required by payment_requests_cancelled_check. */
export const CancelPaymentRequestBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
export type CancelPaymentRequestBody = z.infer<typeof CancelPaymentRequestBodySchema>;

/** Query of GET /v1/payables/payment-requests: statuses (repeatable), a search over number and vendor, a page. */
export const ListPaymentRequestsQuerySchema = z.strictObject({
  status: multi(PaymentRequestStatusSchema),
  q: searchParam,
  ...limitOffset({ max: 100, fallback: 25 }),
});
export type ListPaymentRequestsQuery = z.infer<typeof ListPaymentRequestsQuerySchema>;
