// Pure rules of purchase orders (P4 unit P3; AD4; F1-Q40): the `po_amendment` workflow spec, the amendment facts,
// when an amendment needs approval, amended line arithmetic, version totals and the short-close quantities. No I/O,
// so every rule is cheap to table-test. Serves the NFRs "money moves only after the right people agree" (F1-Q40,
// Kuu 2026-11-20, replacing AD7's band rule: an amendment is re-approved when the order's total rises or its payment
// terms change; any other change is applied at once and audited) and "amounts are exact" (decimal.js,
// ROUND_HALF_UP, strings).
import {
  PoStatusSchema,
  limitOffset,
  multi,
  searchParam,
  ShortClosePurchaseOrderBodySchema,
  type PoApprovedBand,
  type PoStatus,
} from '@bos/contracts';
import Decimal from 'decimal.js';
import { z } from 'zod';

import { poBandOf, quotationLineAmounts, sumMoney } from '../sourcing/sourcing.rules';

/** approval_requests.document_type of a re-approved amendment; the document id is the amendment's own id. */
export const PO_AMENDMENT_DOCUMENT_TYPE = 'po_amendment';

/** The audit entity type of the module's domain events. */
export const PO_AUDIT_ENTITY = 'purchase_orders';

/**
 * The workflow the seed unit publishes for `po_amendment` (v1). Same shape as the commitment route (AD10, AD4,
 * AD8): Accountant → Finance on the amended grand total incl. VAT in NPR; above 100,000.00 adds Management, above
 * 1,000,000.00 adds Founder, and a second, distinct Management step when the Founder amended the PO. The one copy
 * the tests and the hand-back quote; the seed copies it word for word.
 */
export const PO_AMENDMENT_WORKFLOW_SPEC: unknown = {
  documentType: PO_AMENDMENT_DOCUMENT_TYPE,
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: an Accountant checks the amended purchase order',
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance commits the amended budget',
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
        reason: 'Management approval because the amended order exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Amended order of NPR {amountNpr} is above NPR 100,000.00',
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
        reason: 'Founder approval because the amended order exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Amended order of NPR {amountNpr} is above NPR 1,000,000.00',
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
        reason: 'A second Management approval replaces the Founder, who amended this order (AD8)',
      },
      position: 'end',
      reason: 'The Founder amended an order to NPR {amountNpr}, above NPR 1,000,000.00',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'management' } },
};

export interface AmendmentFacts extends Record<string, unknown> {
  /** Amended grand total incl. VAT, in NPR, as a numeric(18,2) string (AD3, AD7). */
  amountNpr: string;
  /** The band the PO was approved in before this amendment. */
  approvedBand: PoApprovedBand;
  requesterIsFounder: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// When an amendment is approved first (F1-Q40)
// ---------------------------------------------------------------------------------------------------------------

/** Why an amendment goes to the approval route. */
export type AmendmentApprovalReason = 'value_rises' | 'terms_change';

/**
 * F1-Q40 (Kuu, 2026-11-20): an amendment is approved first when the order's total incl. VAT rises above its current
 * total, or its payment terms change. Any other change (a lower total, the same total) is applied at once and only
 * audited. Both totals are in the order's currency at its own rate, so comparing them is comparing NPR values. The
 * purchase order has no delivery terms of its own; a vendor change is not an amendment (no vendor field).
 */
export function amendmentApprovalReasons(i: {
  currentTotal: string;
  nextTotal: string;
  currentTermsDays: number;
  nextTermsDays: number;
}): AmendmentApprovalReason[] {
  const reasons: AmendmentApprovalReason[] = [];
  if (new Decimal(i.nextTotal).greaterThan(i.currentTotal)) reasons.push('value_rises');
  if (i.nextTermsDays !== i.currentTermsDays) reasons.push('terms_change');
  return reasons;
}

// ---------------------------------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------------------------------

const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** A version's totals: the sum of line totals (vendor currency), its NPR value at the PO's rate, and its band. */
export function versionTotals(
  lineTotals: readonly string[],
  fxRate: string,
): { total: string; totalNpr: string; band: PoApprovedBand } {
  const total = sumMoney(lineTotals);
  const totalNpr = money(new Decimal(total).times(fxRate));
  return { total, totalNpr, band: poBandOf(totalNpr) };
}

// ---------------------------------------------------------------------------------------------------------------
// Amended lines
// ---------------------------------------------------------------------------------------------------------------

export interface PoLineState {
  id: string;
  orderedQuantity: string;
  cancelledQuantity: string;
  unitPrice: string;
  taxCodeId: string;
  /** Net received on the line, every receipt line whatever its status (as receipt_lines_guard counts it). */
  receivedQuantity: string;
}

export interface AmendedLine {
  id: string;
  orderedQuantity: string;
  unitPrice: string;
  gross: string;
  taxAmount: string;
  lineTotal: string;
}

export type AmendVerdict =
  { ok: true; lines: AmendedLine[]; changed: boolean } | { ok: false; message: string };

/**
 * Applies the changes to the PO's current lines (a line not named keeps its quantity and price) and recomputes the
 * amounts at each line's tax rate. `changed` says whether any quantity or price moved; the caller refuses an
 * amendment that changes neither a line nor the terms. Refused: a line of another PO, a line named twice, and an
 * ordered quantity below what is already received plus what is cancelled.
 */
export function amendLines(
  current: readonly PoLineState[],
  changes: readonly {
    poLineId: string;
    quantity?: string | undefined;
    unitPrice?: string | undefined;
  }[],
  rateBpOf: (taxCodeId: string) => number,
): AmendVerdict {
  const byId = new Map(current.map((l) => [l.id, l]));
  const changeOf = new Map<
    string,
    { quantity?: string | undefined; unitPrice?: string | undefined }
  >();
  for (const c of changes) {
    if (!byId.has(c.poLineId)) {
      return { ok: false, message: `Line ${c.poLineId} is not a line of this purchase order` };
    }
    if (changeOf.has(c.poLineId))
      return { ok: false, message: `Line ${c.poLineId} is named twice` };
    changeOf.set(c.poLineId, c);
  }
  let changed = false;
  const lines: AmendedLine[] = [];
  for (const l of current) {
    const c = changeOf.get(l.id);
    const quantity = new Decimal(c?.quantity ?? l.orderedQuantity);
    const unitPrice = new Decimal(c?.unitPrice ?? l.unitPrice);
    if (!quantity.equals(l.orderedQuantity) || !unitPrice.equals(l.unitPrice)) changed = true;
    const floor = new Decimal(l.receivedQuantity).plus(l.cancelledQuantity);
    if (quantity.lessThan(floor)) {
      return {
        ok: false,
        message: `Line ${l.id} cannot be ordered below ${floor.toFixed(4)} (received plus cancelled)`,
      };
    }
    const amounts = quotationLineAmounts(
      quantity.toFixed(4),
      unitPrice.toFixed(2),
      rateBpOf(l.taxCodeId),
    );
    lines.push({
      id: l.id,
      orderedQuantity: quantity.toFixed(4),
      unitPrice: unitPrice.toFixed(2),
      ...amounts,
    });
  }
  return { ok: true, lines, changed };
}

/** Short-close: each line's cancelled quantity becomes what is still open (ordered - received). */
export function shortCloseCancelled(
  lines: readonly Pick<PoLineState, 'id' | 'orderedQuantity' | 'receivedQuantity'>[],
): { id: string; cancelledQuantity: string }[] {
  return lines.map((l) => {
    const open = Decimal.max(new Decimal(l.orderedQuantity).minus(l.receivedQuantity), 0);
    return { id: l.id, cancelledQuantity: open.toFixed(4) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Vendor change on a draft (F1-Q40 a)
// ---------------------------------------------------------------------------------------------------------------

/** The refusal of a vendor change on an order that is no longer a draft, word for word. */
export const PO_VENDOR_CHANGE_NOT_DRAFT = {
  code: 'PO_VENDOR_CHANGE_NOT_DRAFT',
  message: 'Cancel this order and create a new one',
} as const;

/**
 * The refusal of a vendor change on a draft a payment request, bill or portal bill submission already names: each
 * refers to the order together with its vendor (a composite foreign key), so the vendor cannot move under it.
 */
export const PO_REFERENCED = {
  code: 'PO_REFERENCED',
  message: 'Payment requests or bills already refer to this order; cancel it and create a new one',
} as const;

/**
 * Why the vendor of an order cannot change to `nextVendorId`, or null when it can as far as the order goes (the new
 * vendor's own checks are the service's). Only a draft changes vendor: an issued order went to its vendor, so it is
 * cancelled and raised again. Changing to the same vendor changes nothing and is refused.
 */
export function vendorChangeRefusal(i: {
  status: PoStatus;
  vendorId: string;
  nextVendorId: string;
}): { code: string; message: string } | null {
  if (i.status !== 'draft') return PO_VENDOR_CHANGE_NOT_DRAFT;
  if (i.vendorId === i.nextVendorId) {
    return {
      code: 'PO_VENDOR_UNCHANGED',
      message: 'The purchase order already has this vendor',
    };
  }
  return null;
}

/** The header fields a vendor change rewrites. */
export interface VendorChangeFields {
  vendorId: string;
  paymentTermsDays: number;
  advancePercent: string;
  rfqId: string | null;
  vendorQuotationId: string | null;
}

/**
 * What a vendor change writes and audits: the new vendor with its account's payment terms, no advance, and the link
 * to the RFQ and quotation cleared (the quotation was the old vendor's; both are cleared together, as the
 * purchase_orders CHECK requires). Lines, prices, currency, rate and the approved total and band are left as the
 * commitment approved them. `cleared` names the fields the change reset.
 */
export function vendorChangePatch(
  current: VendorChangeFields,
  next: { vendorId: string; paymentTermsDays: number },
): {
  set: VendorChangeFields;
  before: VendorChangeFields;
  cleared: (keyof VendorChangeFields)[];
} {
  const set: VendorChangeFields = {
    vendorId: next.vendorId,
    paymentTermsDays: next.paymentTermsDays,
    advancePercent: '0',
    rfqId: null,
    vendorQuotationId: null,
  };
  const before: VendorChangeFields = {
    vendorId: current.vendorId,
    paymentTermsDays: current.paymentTermsDays,
    advancePercent: current.advancePercent,
    rfqId: current.rfqId,
    vendorQuotationId: current.vendorQuotationId,
  };
  const cleared: (keyof VendorChangeFields)[] = [];
  if (!new Decimal(current.advancePercent).isZero()) cleared.push('advancePercent');
  if (current.rfqId !== null) cleared.push('rfqId');
  if (current.vendorQuotationId !== null) cleared.push('vendorQuotationId');
  return { set, before, cleared };
}

// ---------------------------------------------------------------------------------------------------------------
// Bodies (the contracts own them; re-exported so the controller and the service keep one import)
// ---------------------------------------------------------------------------------------------------------------

/** Cancel takes the same body as short-close: a reason (stored as closed_reason). */
export const CancelPurchaseOrderBodySchema = ShortClosePurchaseOrderBodySchema;
export type CancelPurchaseOrderBody = z.infer<typeof CancelPurchaseOrderBodySchema>;

/** Query of the list route: statuses (repeatable), a search over the number and the vendor, and a page window. */
export const ListPurchaseOrdersQuerySchema = z.strictObject({
  status: multi(PoStatusSchema),
  q: searchParam,
  ...limitOffset({ max: 100, fallback: 25 }),
});
export type ListPurchaseOrdersQuery = z.infer<typeof ListPurchaseOrdersQuerySchema>;

export {
  AmendPurchaseOrderBodySchema,
  CancelAndRecreatePurchaseOrderBodySchema,
  ChangePurchaseOrderVendorBodySchema,
  ShortClosePurchaseOrderBodySchema,
  type AmendPurchaseOrderBody,
  type CancelAndRecreatePurchaseOrderBody,
  type ChangePurchaseOrderVendorBody,
  type ShortClosePurchaseOrderBody,
} from '@bos/contracts';
