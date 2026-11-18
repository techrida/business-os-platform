// A named approver for one role step of a request: the author picks one eligible person at submit, and then
// only that person (or their delegate, for an approver who holds the step's role) sees and decides the step.
// Without a choice the step stays open to every eligible holder of its role, exactly as before.
//
// The choice is stored in the request's `facts` (jsonb, written once at submit and never updated), keyed by
// the step's seq, the same pattern as the explicit-route marker. No migration: the stored step row keeps its
// role, so the role check, reroute, the SLA tick and the audit trail read it as before.
import type { RoleKey } from '@bos/contracts';

import type { DirectoryData } from './router';

/**
 * When enabled, a user holding the Sales role may be chosen as the named approver of the
 * first step of a quotation approval, and may then see and decide ONLY that one assigned step. It grants no
 * `approvals.requests.act`, lists no other request in their inbox and lets them decide nothing else.
 * Set to false to switch it off: Sales users can no longer be chosen, and an open request already assigned to
 * a Sales user falls back to the step's role holders (every eligible accountant).
 */
export const SALES_MAY_APPROVE_ASSIGNED_QUOTATIONS = true;

/** The document types whose named approver may hold a role other than the step's, and which roles. */
const OUTSIDE_ROLE_ASSIGNEES: Readonly<Record<string, readonly RoleKey[]>> =
  SALES_MAY_APPROVE_ASSIGNED_QUOTATIONS ? { quotation_version: ['sales'] } : {};

/** The roles, besides the step's own, whose holders may be named for `documentType`. Empty when none. */
export function outsideRoleAssigneeRoles(documentType: string): readonly RoleKey[] {
  return OUTSIDE_ROLE_ASSIGNEES[documentType] ?? [];
}

/** Key in `approval_requests.facts`: `{ seq, userId }` of the named approver. */
export const ASSIGNEE_FACT = 'assignedApprover';
/** Only the first step can be assigned (the quotation's accountant step). */
export const ASSIGNABLE_SEQ = 1;

/** The stored choice for step `seq`, or null when the request names nobody for it. */
export function assigneeOf(facts: unknown, seq: number): string | null {
  if (facts === null || typeof facts !== 'object') return null;
  const raw = (facts as Record<string, unknown>)[ASSIGNEE_FACT];
  if (raw === null || typeof raw !== 'object') return null;
  const { seq: s, userId } = raw as { seq?: unknown; userId?: unknown };
  return s === seq && typeof userId === 'string' && userId !== '' ? userId : null;
}

/** The facts to store with a choice for the first step. */
export function withAssignee(
  facts: Record<string, unknown>,
  userId: string,
): Record<string, unknown> {
  return { ...facts, [ASSIGNEE_FACT]: { seq: ASSIGNABLE_SEQ, userId } };
}

/**
 * The named approver who still counts for a stored role step, or null (the step is open to its role).
 * `outsideRole` is true when they are there only through OUTSIDE_ROLE_ASSIGNEES (a Sales user): then no
 * delegate may act for them. A named person who has since lost every qualifying role (or left: the role lists
 * hold active members only), or a widening switched off, falls back to the role, so a step never waits on
 * someone who can no longer decide it.
 */
export function effectiveAssignee(
  facts: unknown,
  documentType: string,
  step: { seq: number; kind: string; roleKey: string | null },
  data: Pick<DirectoryData, 'roleMembers'>,
): { userId: string; outsideRole: boolean } | null {
  const userId = assigneeOf(facts, step.seq);
  if (userId === null || step.kind !== 'role' || step.roleKey === null) return null;
  if ((data.roleMembers.get(step.roleKey) ?? []).includes(userId)) {
    return { userId, outsideRole: false };
  }
  const outside = outsideRoleAssigneeRoles(documentType).some((role) =>
    (data.roleMembers.get(role) ?? []).includes(userId),
  );
  return outside ? { userId, outsideRole: true } : null;
}
