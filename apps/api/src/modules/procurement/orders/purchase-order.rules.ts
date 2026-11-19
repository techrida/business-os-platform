// Pure rules of purchase orders (P4 unit P3; AD4, AD7): the `po_amendment` workflow spec, the amendment facts, the
// band comparison, amended line arithmetic, version totals and the short-close quantities. No I/O, so every rule is
// cheap to table-test. Serves the NFRs "money moves only after the right people agree" (an amendment is re-approved
// only when the band of its grand total incl. VAT in NPR is higher than the band already approved, AD7) and "amounts
// are exact" (decimal.js, ROUND_HALF_UP, strings).
import {
  PO_APPROVED_BANDS,
  PoStatusSchema,
  limitOffset,
  multi,
  searchParam,
  ShortClosePurchaseOrderBodySchema,
  type PoApprovedBand,
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
// Bands and totals
// ---------------------------------------------------------------------------------------------------------------

/** AD7: true when `next` is a higher band than `approved` (base < management < founder). */
export function bandRises(next: PoApprovedBand, approved: PoApprovedBand): boolean {
  return PO_APPROVED_BANDS.indexOf(next) > PO_APPROVED_BANDS.indexOf(approved);
}

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

export type AmendVerdict = { ok: true; lines: AmendedLine[] } | { ok: false; message: string };

/**
 * Applies the changes to the PO's current lines (a line not named keeps its quantity and price) and recomputes the
 * amounts at each line's tax rate. Refused: a line of another PO, a line named twice, a change that changes
 * nothing, and an ordered quantity below what is already received plus what is cancelled.
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
  return changed ? { ok: true, lines } : { ok: false, message: 'The amendment changes no line' };
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
  ShortClosePurchaseOrderBodySchema,
  type AmendPurchaseOrderBody,
  type ShortClosePurchaseOrderBody,
} from '@bos/contracts';
