import type { QuotationDetail } from '@bos/contracts';

import { hasPermission } from '@/components/p2/customers/permissions';

/**
 * Whether these roles may see what a quotation costs and earns. The API returns unit cost and
 * margin to every `quotation.read` caller, so the screen decides: the people who draft quotations
 * or act on their approval requests see them, everyone else does not. Server-side only.
 */
export function canSeeInternalFigures(roles: readonly string[]): boolean {
  return hasPermission(roles, 'quotation.draft') || hasPermission(roles, 'approvals.requests.act');
}

/**
 * A copy of the detail with every internal figure removed from every version: each line's unit
 * cost, the cost total and the margin. Call it in the server component before the data reaches
 * any component, so the figures never enter the rendered page or its serialized props.
 */
export function withoutInternalFigures(detail: QuotationDetail): QuotationDetail {
  return {
    ...detail,
    versions: detail.versions.map((version) => ({
      ...version,
      lines: version.lines.map((line) => ({ ...line, unitCost: null })),
      internalCostTotal: null,
      marginPct: null,
    })),
  };
}
