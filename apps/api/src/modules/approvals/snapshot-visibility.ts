// What an approval request's frozen snapshot shows its reader (D29): internal cost figures follow the viewer's LIVE
// grants, not the grants of whoever submitted. A quotation snapshot carries `marginPct`; it leaves the API only for a
// staff caller holding `quotation.cost.read`, and for everyone else the key is ABSENT (null would mean "no cost
// recorded"). This is an output filter on the response only: the stored snapshot, its SHA-256 and every decision rule
// stay untouched, so what was approved is still what was frozen.
import type { ApprovalRequestDto } from '@bos/contracts';

import type { Principal } from '../../platform/authz/principal';
import { canReadCost } from '../quotations/drafting/cost-visibility';

// Spelled out here, not imported from the quotation subject, so the approvals engine does not load the quotation
// module's code (the subject imports the engine's types). Same value as QUOTATION_VERSION_DOCUMENT_TYPE.
const QUOTATION_DOCUMENT_TYPE = 'quotation_version';

/** Snapshot keys that hold an internal cost or margin figure, by document type. Only quotations have any. */
const COST_KEYS_BY_DOCUMENT_TYPE: ReadonlyMap<string, readonly string[]> = new Map([
  [QUOTATION_DOCUMENT_TYPE, ['marginPct', 'internalCostTotal']],
]);

/** `snapshot` without the cost keys of its document type. Pure: a copy, or the same value when nothing is removed. */
export function withoutCostKeys(documentType: string, snapshot: unknown): unknown {
  const keys = COST_KEYS_BY_DOCUMENT_TYPE.get(documentType);
  if (keys === undefined || typeof snapshot !== 'object' || snapshot === null) return snapshot;
  if (Array.isArray(snapshot)) return snapshot;
  const object = snapshot as Record<string, unknown>;
  if (!keys.some((key) => key in object)) return snapshot;
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

/** `request` as `p` may see it: unchanged with `quotation.cost.read`, otherwise its snapshot without cost figures. */
export function requestVisibleTo(p: Principal, request: ApprovalRequestDto): ApprovalRequestDto {
  if (canReadCost(p)) return request;
  const snapshot = withoutCostKeys(request.documentType, request.snapshot);
  return snapshot === request.snapshot ? request : { ...request, snapshot };
}
