// The pure part of the quotation preview: the request body becomes a PricingInput, and the priced version becomes the
// PreviewResult of @bos/contracts (the shape the workspace parses). No database and no clock, so unit tests feed it
// the real priceQuotation output. Serves the NFR "amounts are exact": every figure stays the string pricing made.
import type { NprSnapshot, PreviewResult, QuotationPreviewBody, RoutePlan } from '@bos/contracts';

import type { PricedVersion, PricingInput, QuoteFacts } from '../pricing/pricing.types';

/**
 * The body the workspace sends carries currency, lines and the discount, and no issue date. A body without a
 * discount means "no discount" (the builder omits it when the user removed it), so it is never filled from the saved
 * draft; only the issue date, which the body cannot carry, is the saved version's.
 */
export function toPricingInput(body: QuotationPreviewBody, issueDate: string): PricingInput {
  return {
    currency: body.currency,
    issueDate,
    discount: body.discount ?? null,
    lines: body.lines.map((line, index) => ({
      lineNo: index + 1,
      catalogItemId: line.catalogItemId ?? null,
      description: line.description,
      uom: line.uom,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxCodeId: line.taxCodeId,
      unitCost: line.unitCost ?? null,
    })),
  };
}

/**
 * The facts the approval workflow rules read, as the router compares them (decimal.js on strings, never floats):
 * `amountNpr` (D02, the grand total in NPR, strict greater-than) and `effectiveDiscountPct` unrounded, plus the exact
 * strictly-above-12% flag, so a rule never depends on the rounded 4-decimal text.
 */
export function approvalFactsOf(facts: QuoteFacts): {
  amountNpr: string;
  effectiveDiscountPct: string;
  discountApprovalRequired: boolean;
} {
  return {
    amountNpr: facts.amountNpr,
    effectiveDiscountPct: facts.effectiveDiscountPct,
    discountApprovalRequired: facts.discountApprovalRequired,
  };
}

/** Only a foreign-currency document has an NPR snapshot; an NPR document is its own NPR value. */
function nprSnapshotOf(priced: PricedVersion): NprSnapshot | null {
  const { fxSource, fxDate, fxRate, amountNpr } = priced.columns;
  if (priced.facts.currency === 'NPR' || fxSource === null || fxDate === null) return null;
  return { amountNpr, rate: fxRate, rateSource: fxSource, rateDate: fxDate };
}

/** The response of the preview. The totals come from the columns (4-decimal percentage), never from the facts. */
export function previewResultOf(priced: PricedVersion, route: RoutePlan): PreviewResult {
  const c = priced.columns;
  return {
    totals: {
      subtotal: c.subtotal,
      discountAmount: c.discountAmount,
      taxableAmount: c.taxableAmount,
      taxAmount: c.taxAmount,
      total: c.total,
      effectiveDiscountPct: c.effectiveDiscountPct,
    },
    taxSummary: priced.taxSummary.map((row) => ({
      taxCodeId: row.taxCodeId,
      label: row.label,
      rate: row.rate,
      base: row.base,
      tax: row.tax,
    })),
    lines: priced.lines.map((line) => ({
      lineNo: line.lineNo,
      gross: line.gross,
      discountAlloc: line.discountAlloc,
      taxable: line.taxable,
    })),
    nprSnapshot: nprSnapshotOf(priced),
    route,
  };
}
