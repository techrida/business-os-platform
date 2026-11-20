// Pure rules of sourcing and the commitment approval (P4 unit P2; AD3, AD4, AD8, AD10, AD12, AD13): the
// `pr_commitment` workflow spec, the commitment facts, the PO band, the quote-count rule, quotation line
// arithmetic and a re-export of the request bodies (the contracts own them). No I/O, so every rule is cheap to table-test.
// Serves the NFRs "money moves only after the right people agree" (the bands are strict `>` on the grand total
// including VAT, in NPR, from the recommended quote) and "amounts are exact" (decimal.js, ROUND_HALF_UP, strings).
import type { PoApprovedBand } from '@bos/contracts';
import { bandFor, parseDecimal } from '@bos/money-rules';
import Decimal from 'decimal.js';
import { z } from 'zod';

/** approval_requests.document_type of a commitment; the document id is the RFQ id. */
export const PR_COMMITMENT_DOCUMENT_TYPE = 'pr_commitment';

/** Numbering series keys: RFQ-2082/83-00001 and the draft PO's number. */
export const RFQ_SERIES = 'RFQ';
export const PO_SERIES = 'PO';

/** The audit entity type of the module's domain events. */
export const RFQ_AUDIT_ENTITY = 'rfqs';

/** AD13: `procurement.min_quotes` when the setting is absent. */
export const DEFAULT_MIN_QUOTES = 3;

/**
 * The workflow the seed unit publishes for `pr_commitment` (v1). AD10: Accountant → Finance on the recommended
 * quote. AD4 (strict >): above 100,000.00 adds Management, above 1,000,000.00 adds Founder. AD8: when the requester
 * is the Founder, a second, distinct Management step replaces the Founder step. distinctApprovers makes the two
 * Management steps two people; the router blocks the plan when the directory cannot supply them, and the service
 * answers 422. Kept here as the one copy the tests and the
 * hand-back quote; the seed copies it word for word.
 */
export const PR_COMMITMENT_WORKFLOW_SPEC: unknown = {
  documentType: PR_COMMITMENT_DOCUMENT_TYPE,
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: an Accountant checks the recommended quotation',
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance commits the budget',
    },
  ],
  rules: [
    {
      id: 'management',
      when: { field: 'amountNpr', op: 'gt', value: '100000.00' },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because the commitment exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Commitment of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: false },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because the commitment exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Commitment of NPR {amountNpr} is above NPR 1,000,000.00',
    },
    {
      id: 'management_second',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management_second',
        kind: 'role',
        role: 'management',
        reason: 'A second Management approval replaces the Founder, who raised this request (AD8)',
      },
      position: 'end',
      reason: 'The Founder raised a commitment of NPR {amountNpr}, above NPR 1,000,000.00',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'management' } },
};

// ---------------------------------------------------------------------------------------------------------------
// Facts, band, quote count
// ---------------------------------------------------------------------------------------------------------------

export interface CommitmentFacts extends Record<string, unknown> {
  /** Grand total incl. VAT, in NPR, from the recommended quote, as a numeric(18,2) string (AD3). */
  amountNpr: string;
  requesterIsFounder: boolean;
  isEmergency: boolean;
}

export function commitmentFactsOf(i: CommitmentFacts): CommitmentFacts {
  return {
    amountNpr: i.amountNpr,
    requesterIsFounder: i.requesterIsFounder,
    isEmergency: i.isEmergency,
  };
}

/** purchase_orders.approved_band for an approved NPR total: AD4's band, `none` stored as `base`. */
export function poBandOf(amountNpr: string): PoApprovedBand {
  const band = bandFor(parseDecimal(amountNpr));
  return band === 'none' ? 'base' : band;
}

export type QuoteCountVerdict =
  { ok: true; fewerThanThreeReason: string | null } | { ok: false; message: string };

/**
 * AD13 and AD12: at least `minQuotes` quotations, or a `fewerThanThreeReason`. An emergency request may go below
 * the minimum on its emergency reason (stored as the reason when none is given). No quotation at all is refused.
 */
export function quoteCountVerdict(i: {
  count: number;
  minQuotes: number;
  fewerThanThreeReason: string | undefined;
  isEmergency: boolean;
  emergencyReason: string | null;
}): QuoteCountVerdict {
  if (i.count === 0) return { ok: false, message: 'The RFQ has no quotation to recommend' };
  if (i.count >= i.minQuotes) return { ok: true, fewerThanThreeReason: null };
  if (i.fewerThanThreeReason !== undefined) {
    return { ok: true, fewerThanThreeReason: i.fewerThanThreeReason };
  }
  if (i.isEmergency && i.emergencyReason !== null && i.emergencyReason.trim() !== '') {
    return { ok: true, fewerThanThreeReason: `Emergency purchase: ${i.emergencyReason}` };
  }
  return {
    ok: false,
    message: `Only ${i.count} of ${i.minQuotes} quotations: fewerThanThreeReason is required`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Quotation deadline (F1-Q47)
// ---------------------------------------------------------------------------------------------------------------

/**
 * The 409 code and its one sentence for a quotation that arrives after the RFQ's deadline. The workspace and the
 * vendor portal recognise the refusal by the code, or by this exact sentence while the error filter does not yet
 * pass the code; change both copies together.
 */
export const RFQ_DEADLINE_PASSED = 'rfq_deadline_passed';
export const RFQ_DEADLINE_PASSED_MESSAGE =
  'The quotation deadline of this RFQ has passed. Procurement can extend it to take more quotations.';

/**
 * F1-Q47: a quotation is late when it arrives strictly after the deadline (both instants, so the deadline's own
 * offset does not matter). One that arrives at the deadline itself is in time.
 */
export function isLateQuotation(deadline: Date, arrivedAt: Date): boolean {
  return arrivedAt.getTime() > deadline.getTime();
}

export type ExtendDeadlineVerdict =
  { ok: true } | { ok: false; refusal: 'not_open' | 'deadline_in_past' | 'not_later' };

/**
 * F1-Q47: Procurement extends the deadline of an open RFQ only, to an instant after now and after the current
 * deadline. An extension of an RFQ whose deadline passed lets the invited vendors quote again.
 */
export function extendDeadlineVerdict(i: {
  status: string;
  current: Date;
  next: Date;
  now: Date;
}): ExtendDeadlineVerdict {
  if (i.status !== 'open') return { ok: false, refusal: 'not_open' };
  if (i.next.getTime() <= i.now.getTime()) return { ok: false, refusal: 'deadline_in_past' };
  if (i.next.getTime() <= i.current.getTime()) return { ok: false, refusal: 'not_later' };
  return { ok: true };
}

/**
 * The body of `POST /v1/procurement/rfqs/:id/deadline`: the new deadline with its offset, like the create body's.
 * Kept here, not in the contracts, until a client outside the workspace needs it.
 */
export const ExtendRfqDeadlineBodySchema = z.strictObject({
  deadline: z.iso.datetime({ offset: true }),
});
export type ExtendRfqDeadlineBody = z.infer<typeof ExtendRfqDeadlineBodySchema>;

// ---------------------------------------------------------------------------------------------------------------
// Quotation arithmetic
// ---------------------------------------------------------------------------------------------------------------

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** gross = round(qty * price, 2); tax = round(gross * rate_bp / 10000, 2); line_total = gross + tax (0033 CHECKs). */
export function quotationLineAmounts(
  quantity: string,
  unitPrice: string,
  rateBp: number,
): { gross: string; taxAmount: string; lineTotal: string } {
  const gross = new Decimal(money(new Decimal(quantity).times(unitPrice)));
  const tax = new Decimal(money(gross.times(rateBp).dividedBy(10000)));
  return {
    gross: gross.toFixed(2),
    taxAmount: tax.toFixed(2),
    lineTotal: gross.plus(tax).toFixed(2),
  };
}

export function sumMoney(values: readonly string[]): string {
  return values.reduce((acc, v) => acc.plus(v), new Decimal(0)).toFixed(2);
}

// ---------------------------------------------------------------------------------------------------------------
// Bodies (the contracts own them; re-exported so the controller and the service keep one import)
// ---------------------------------------------------------------------------------------------------------------

export {
  ConvertSubmissionBodySchema,
  CreateRfqBodySchema,
  QuotationLineBodySchema,
  RecordQuotationBodySchema,
  ScoreQuotationBodySchema,
  type ConvertSubmissionBody,
  type CreateRfqBody,
  type RecordQuotationBody,
  type ScoreQuotationBody,
} from '@bos/contracts';
