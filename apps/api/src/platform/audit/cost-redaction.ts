// The audit trail's output filter for a quotation's internal cost figures (D29). The row triggers record every
// column of app.quotation_lines (unit_cost) and app.quotation_versions (internal_cost_total, margin_pct), and a
// quotation approval request's snapshot carries marginPct; those figures leave GET /v1/audit only for a staff caller
// whose live grants hold `quotation.cost.read`. For everyone else the row stays in the list and only the keys are
// ABSENT from `before` and `after` (null would mean "no cost recorded").
//
// The stored events and the hash chain are untouched: GET /v1/audit/verify still recomputes every hash in the
// database. `canonical` is the exact text the hash covers, so it cannot be shown without the figures it holds: a side
// that lost a key has its canonical text withheld (null). Re-hashing such a row outside the API needs the permission.
//
// Table and permission names are spelled out here so the platform audit module does not load quotation code.
import type { AuditEventDto, Permission } from '@bos/contracts';

import { can } from '../authz/can';
import type { Principal } from '../authz/principal';

const COST_READ: Permission = 'quotation.cost.read';

/** Same value as the approvals engine's quotation document type (QUOTATION_VERSION_DOCUMENT_TYPE). */
const QUOTATION_DOCUMENT_TYPE = 'quotation_version';

/** Row columns that hold a cost figure, by audited table (the trigger's entity type is the bare table name). */
const COST_COLUMNS_BY_TABLE: ReadonlyMap<string, readonly string[]> = new Map([
  ['quotation_lines', ['unit_cost']],
  ['quotation_versions', ['internal_cost_total', 'margin_pct']],
]);

/** Keys of a quotation approval snapshot that hold a cost figure (the same keys the approvals API strips). */
const SNAPSHOT_COST_KEYS: readonly string[] = ['marginPct', 'internalCostTotal'];

/** May `p` see cost figures in the trail? Same rule as the quotation reads: an active staff user with the grant. */
export function mayReadCostFigures(p: Principal | undefined): boolean {
  return p !== undefined && p.orgKind === 'staff' && can(p, COST_READ).allowed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function without(
  object: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

/** One side (`before` or `after`) of `entityType`'s row without its cost figures, or the same value if it has none. */
function sideWithoutCost(entityType: string, side: unknown): unknown {
  if (!isObject(side)) return side;
  const columns = COST_COLUMNS_BY_TABLE.get(entityType);
  if (columns !== undefined) {
    return columns.some((key) => key in side) ? without(side, columns) : side;
  }
  if (entityType === 'approval_requests' && side.document_type === QUOTATION_DOCUMENT_TYPE) {
    const snapshot = side.snapshot;
    if (isObject(snapshot) && SNAPSHOT_COST_KEYS.some((key) => key in snapshot)) {
      return { ...side, snapshot: without(snapshot, SNAPSHOT_COST_KEYS) };
    }
  }
  return side;
}

/** `event` without cost figures. Pure: a copy, or the same event when it holds none. */
export function withoutCostFigures(event: AuditEventDto): AuditEventDto {
  const before = sideWithoutCost(event.entityType, event.before);
  const after = sideWithoutCost(event.entityType, event.after);
  if (before === event.before && after === event.after) return event;
  return {
    ...event,
    before,
    after,
    canonical: {
      ...event.canonical,
      before: before === event.before ? event.canonical.before : null,
      after: after === event.after ? event.canonical.after : null,
    },
  };
}

/** A page of events as `p` may see it: unchanged with `quotation.cost.read`, cost figures removed otherwise. */
export function eventsVisibleTo<E extends AuditEventDto>(
  p: Principal | undefined,
  events: E[],
): E[] {
  return mayReadCostFigures(p) ? events : events.map((e) => withoutCostFigures(e) as E);
}
