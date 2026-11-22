// Pure rules of vendor bills (P4 unit A1; AD5, AD6, AD14): the `vendor_bill` and `match_exception` workflow specs,
// the line arithmetic, the match inputs of a line, the approval facts and the status moves. No I/O, so every rule
// is cheap to table-test.
// Serves the NFRs "amounts are exact" (decimal.js, ROUND_HALF_UP, strings; VAT from the tax code's rate on the line
// net) and "money moves only after the right people agree" (a bill reaches approval only when every line matches
// or Finance accepted the variance; the person who entered it is never its Accountant).
import {
  BillStatusSchema,
  canTransitionBill,
  limitOffset,
  multi,
  searchParam,
  type BillStatus,
  type MatchStatus,
} from '@bos/contracts';
import {
  bandFor,
  evaluateLine,
  parseDecimal,
  roundMoney,
  type ApprovalBand,
  type BandThresholds,
  type MatchLineResult,
  type MatchTolerance,
} from '@bos/money-rules';
import { kathmanduDateString } from '@bos/locale';
import { UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { z } from 'zod';

/** approval_requests.document_type of a bill; the document id is the bill id. */
export const VENDOR_BILL_DOCUMENT_TYPE = 'vendor_bill';
/** approval_requests.document_type of a match exception; the document id is the exception id. */
export const MATCH_EXCEPTION_DOCUMENT_TYPE = 'match_exception';

/** The audit entity type of the module's domain events. */
export const BILL_AUDIT_ENTITY = 'vendor_bills';
export const MATCH_EXCEPTION_AUDIT_ENTITY = 'match_exceptions';

/**
 * 422 BILL_DATE_IN_FUTURE: a vendor invoice cannot be dated after today in Kathmandu. Bill entry, the conversion of a
 * portal submission and the vendor's own portal submission all refuse it; the clients' `max` is advisory.
 */
export function assertInvoiceDateByToday(invoiceDate: string, now: Date): void {
  const today = kathmanduDateString(now);
  if (invoiceDate <= today) return;
  throw new UnprocessableEntityException({
    code: 'BILL_DATE_IN_FUTURE',
    message: `The invoice date ${invoiceDate} is after today (${today}); use today or an earlier date`,
    details: { invoiceDate, today },
  });
}

/** The unique key that makes INV-001, inv 001 and INV/001 one invoice of a vendor in a fiscal year (check 8). */
export const BILL_DEDUP_CONSTRAINT = 'vendor_bills_tenant_org_vendor_invoice_fy_unique';

/** PO statuses a bill may be matched against: issued and receiving. */
export const BILLABLE_PO_STATUSES = ['issued', 'partially_received', 'fully_received'] as const;

/**
 * The workflow the seed unit publishes for `vendor_bill` (v1). AD5: a bill goes Accountant → Finance; the person
 * who entered it is in sod_user_ids, so the Accountant step is another accountant. A non-PO bill adds the bands of
 * AD4 on its total including VAT, in NPR (`band` comes from bandFor, strict >). Kept here as the one copy the tests
 * and the hand-back quote; the seed copies it word for word.
 */
export const VENDOR_BILL_WORKFLOW_SPEC: unknown = {
  documentType: VENDOR_BILL_DOCUMENT_TYPE,
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: an Accountant who did not enter the bill checks it',
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance accepts the payable',
    },
  ],
  rules: [
    {
      id: 'management',
      when: {
        all: [
          { field: 'poMatched', op: 'eq', value: false },
          { field: 'band', op: 'in', value: ['management', 'founder'] },
        ],
      },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason:
          'Management approval because a bill without a purchase order exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Non-PO bill of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'poMatched', op: 'eq', value: false },
          { field: 'band', op: 'eq', value: 'founder' },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because a bill without a purchase order exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Non-PO bill of NPR {amountNpr} is above NPR 1,000,000.00',
    },
  ],
};

/**
 * The workflow the seed unit publishes for `match_exception` (v1). AD5: Finance decides whether a bill outside
 * tolerance may go on; the requester is in sod_user_ids.
 */
export const MATCH_EXCEPTION_WORKFLOW_SPEC: unknown = {
  documentType: MATCH_EXCEPTION_DOCUMENT_TYPE,
  steps: [
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Finance decides whether a bill outside the match tolerance may go to approval',
    },
  ],
  rules: [],
};

// ------------------------------------------------------------------------------------------------- lines

const BP = new Decimal(10000);

/** VAT of a line: round(net x rate_bp / 10000, 2). */
export function vatOf(net: string, rateBp: number): string {
  return roundMoney(parseDecimal(net).times(rateBp).div(BP)).toFixed(2);
}

/** net = round(quantity x unit price, 2) (the vendor_bill_lines_net_amount_check), VAT from the tax rate. */
export function lineAmounts(
  quantity: string,
  unitPrice: string,
  rateBp: number,
): { net: string; vat: string } {
  const net = roundMoney(parseDecimal(quantity).times(parseDecimal(unitPrice))).toFixed(2);
  return { net, vat: vatOf(net, rateBp) };
}

/** Bill totals before approval: TDS is 0 until approval computes it (AD14), so payable = net + VAT. */
export function billTotals(lines: readonly { net: string; vat: string }[]): {
  net: string;
  vat: string;
  gross: string;
} {
  let net = new Decimal(0);
  let vat = new Decimal(0);
  for (const l of lines) {
    net = net.plus(l.net);
    vat = vat.plus(l.vat);
  }
  return { net: net.toFixed(2), vat: vat.toFixed(2), gross: net.plus(vat).toFixed(2) };
}

// ------------------------------------------------------------------------------------------------- matching

/** What the matcher needs of one bill line and its PO line. */
export interface MatchLineFacts {
  billedQty: string;
  billPrice: string;
  billVat: string;
  billNet: string;
  orderedQty: string;
  /** v_po_line_progress.received_quantity: confirmed receipts net of reversals. */
  receivedQty: string;
  /** v_po_line_progress.billed_quantity: every live bill on the PO line, this one included. */
  billedOnLine: string;
  /** What this bill itself bills on the same PO line (all its lines on it). */
  billedByThisBill: string;
  poPrice: string;
  /** The PO line's tax rate: the VAT the bill net should carry at the agreed tax code. */
  poRateBp: number;
}

/**
 * The evaluateLine input of a bill line (AD6).
 * - Quantity: what is still unbilled of what arrived, so a second bill against the same receipt fails:
 *   received - (billed on the line - this bill's own quantity on it).
 * - Tax: the bill line's VAT against VAT on the bill net at the PO line's tax rate. Comparing against the PO line's
 *   tax amount would fail every allowed price change (a +2% price moves VAT by 2%), so the tax check catches a
 *   wrong tax code or a hand-typed VAT, to the paisa.
 */
export function matchLine(facts: MatchLineFacts, tolerance: MatchTolerance): MatchLineResult {
  const billedElsewhere = parseDecimal(facts.billedOnLine).minus(
    parseDecimal(facts.billedByThisBill),
  );
  const unbilled = parseDecimal(facts.receivedQty).minus(billedElsewhere);
  const available = unbilled.isNegative() ? '0' : unbilled.toFixed();
  return evaluateLine(
    {
      orderedQty: facts.orderedQty,
      receivedQty: available,
      billedQty: facts.billedQty,
      poPrice: facts.poPrice,
      billPrice: facts.billPrice,
      poTax: vatOf(facts.billNet, facts.poRateBp),
      billTax: facts.billVat,
    },
    tolerance,
  );
}

/** The bill's status and match status after a match run (draft → matching → variance in one command). */
export function afterMatch(
  from: BillStatus,
  allWithin: boolean,
): { status: BillStatus; matchStatus: MatchStatus } | undefined {
  if (from !== 'draft' && from !== 'matching' && from !== 'variance') return undefined;
  return allWithin
    ? { status: 'matching', matchStatus: 'matched' }
    : { status: 'variance', matchStatus: 'variance' };
}

/**
 * Whether a bill may be submitted for approval: every line matched (`matching` + matched), an approved exception
 * (`exception_pending` + exception_approved), or a bill without a PO (draft + not_required).
 */
export function submittable(status: BillStatus, matchStatus: MatchStatus): boolean {
  if (matchStatus === 'matched') return status === 'matching';
  if (matchStatus === 'exception_approved') return status === 'exception_pending';
  if (matchStatus === 'not_required') return status === 'draft' || status === 'matching';
  return false;
}

export { canTransitionBill };

// ------------------------------------------------------------------------------------------------- approval

export interface BillFacts extends Record<string, unknown> {
  /** True when the bill is matched against a purchase order (AD5: no bands). */
  poMatched: boolean;
  /** The AD4 band of the total including VAT in NPR (strict >). */
  band: ApprovalBand;
  amountNpr: string;
}

/** The approval facts of a bill: the band is taken on net + VAT in NPR, before TDS (AD3). */
export function billFactsOf(input: {
  poMatched: boolean;
  gross: string;
  fxRate: string;
  thresholds?: BandThresholds;
}): BillFacts {
  const amountNpr = roundMoney(parseDecimal(input.gross).times(parseDecimal(input.fxRate)));
  return {
    poMatched: input.poMatched,
    band: bandFor(amountNpr, input.thresholds),
    amountNpr: amountNpr.toFixed(2),
  };
}

/** The bill's fiscal year (the dedup key): the BS fiscal year of the invoice date, in Kathmandu. */
export function invoiceInstant(invoiceDate: string): Date {
  return new Date(`${invoiceDate}T00:00:00+05:45`);
}

/** Query of GET /v1/payables/bills: statuses (repeatable), a search over number, vendor invoice and vendor, a page. */
export const ListBillsQuerySchema = z.strictObject({
  status: multi(BillStatusSchema),
  q: searchParam,
  ...limitOffset({ max: 100, fallback: 25 }),
});
export type ListBillsQuery = z.infer<typeof ListBillsQuerySchema>;
