// Who may see a quotation's internal cost figures (D29b). Serves the NFR "authorization is deny-by-default":
// `unitCost` (per line), `internalCostTotal` and `marginPct` leave the API only for a staff caller whose live grants
// hold `quotation.cost.read`; for everyone else the keys are ABSENT (null would mean "no cost recorded").
//
// toQuotationVersionDto (mapping.ts) stays full on purpose: a draft update builds its merge base from it, so
// stripping there would wipe the stored costs. The strip is an output filter, applied where a DTO is RETURNED to the
// caller. exactOptionalPropertyTypes is on, so the keys are omitted, never set to undefined.
import type { Permission, QuotationDetail, QuotationVersionDto } from '@bos/contracts';
import { ConflictException } from '@nestjs/common';

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

/** What a draft save needs of a stored line to keep its cost: the line's identity and the cost itself. */
export interface StoredCostLine {
  catalogItemId?: string | null | undefined;
  description: string;
  uom: string;
  unitCost?: string | null | undefined;
}

/** 409: a caller who cannot see the cost figures tried to change which lines the quotation has. */
export const costFiguresRestricted = () =>
  new ConflictException({
    code: 'cost_figures_restricted',
    message:
      'Lines cannot be added, removed or reordered on a quotation whose cost figures you cannot see',
  });

/**
 * The pricing input of a draft save, with the unit costs the caller may write. A caller who may read costs sets
 * them as the body says (an omitted cost clears it, as before). A caller who may not can neither set nor change nor
 * clear one: a cost has no identity apart from its line, so the stored costs are kept ONLY when the incoming lines
 * are structurally identical to the stored ones (same count and, position by position, the same catalogItemId,
 * description and uom); each line then keeps the stored cost of its position. Any add, remove, reorder or identity
 * edit would shift costs onto other lines, so it is refused (409 cost_figures_restricted) before anything is
 * written. Quantity, unit price, tax code and everything else stay editable. `stored` is the stored lines in line
 * order (empty on create: no line has a cost then, and none is refused). Pricing recomputes the internal cost and
 * the margin from these costs, so the stored totals stay consistent with the stored line costs.
 */
export function pricingWithAllowedCosts(
  input: PricingInput,
  canRead: boolean,
  stored: readonly StoredCostLine[],
): PricingInput {
  if (canRead) return input;
  if (stored.length > 0) {
    const same =
      input.lines.length === stored.length &&
      input.lines.every((line, i) => {
        const old = stored[i]!;
        return (
          (line.catalogItemId ?? null) === (old.catalogItemId ?? null) &&
          line.description === old.description &&
          line.uom === old.uom
        );
      });
    if (!same) throw costFiguresRestricted();
  }
  return {
    ...input,
    lines: input.lines.map((line, i) => ({ ...line, unitCost: stored[i]?.unitCost ?? null })),
  };
}
