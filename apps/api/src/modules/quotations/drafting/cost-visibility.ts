// Who may see a quotation's internal cost figures (D29b). Serves the NFR "authorization is deny-by-default":
// `unitCost` (per line), `internalCostTotal` and `marginPct` leave the API only for a staff caller whose live grants
// hold `quotation.cost.read`; for everyone else the keys are ABSENT (null would mean "no cost recorded").
//
// toQuotationVersionDto (mapping.ts) stays full on purpose: a draft update builds its merge base from it, so
// stripping there would wipe the stored costs. The strip is an output filter, applied where a DTO is RETURNED to the
// caller. exactOptionalPropertyTypes is on, so the keys are omitted, never set to undefined.
import type { Permission, QuotationDetail, QuotationVersionDto } from '@bos/contracts';

import { can, type Principal } from '../../../platform/authz/can';
import type { PricingInput } from '../pricing/pricing.types';

export const COST_READ: Permission = 'quotation.cost.read';

/**
 * May `p` see cost figures now? An active staff user holding `quotation.cost.read` (the grant of the request's live,
 * versioned role cache); a portal caller never may, even if a role row names the key by mistake.
 */
export function canReadCost(p: Principal): boolean {
  return p.orgKind === 'staff' && can(p, COST_READ).allowed;
}

/** `dto` without `internalCostTotal`, `marginPct` and each line's `unitCost`. Pure: returns a copy. */
export function withoutCostFigures(dto: QuotationVersionDto): QuotationVersionDto {
  const { internalCostTotal: _cost, marginPct: _margin, lines, ...rest } = dto;
  return { ...rest, lines: lines.map(({ unitCost: _unitCost, ...line }) => line) };
}

/** `dto` as `p` may see it: unchanged with the permission, without the cost figures otherwise. */
export function versionVisibleTo(p: Principal, dto: QuotationVersionDto): QuotationVersionDto {
  return canReadCost(p) ? dto : withoutCostFigures(dto);
}

/** Every version of a detail answer, as `p` may see it. */
export function detailVisibleTo(p: Principal, detail: QuotationDetail): QuotationDetail {
  return canReadCost(p) ? detail : { ...detail, versions: detail.versions.map(withoutCostFigures) };
}

/**
 * The pricing input of a draft save, with the unit costs the caller may write. A caller who may read costs sets
 * them as the body says (an omitted cost clears it, as before). A caller who may not can neither set nor change nor
 * clear one: each line keeps the stored cost of its line number, and a line number that did not exist before gets
 * none. `stored` maps a line number to its stored cost (empty on create). Pricing then recomputes the internal cost
 * and the margin from these costs, so the stored totals stay consistent with the stored line costs.
 */
export function pricingWithAllowedCosts(
  input: PricingInput,
  canRead: boolean,
  stored: ReadonlyMap<number, string | null>,
): PricingInput {
  if (canRead) return input;
  return {
    ...input,
    lines: input.lines.map((line) => ({ ...line, unitCost: stored.get(line.lineNo) ?? null })),
  };
}
