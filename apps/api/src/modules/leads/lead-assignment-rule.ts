// Who may hand a lead, the work on it, or any activity of it to whom (D50). Pure: no database, no Principal. The
// caller loads the acting user and the candidates as AssignmentParty values (roles, department and level of the
// membership in the acting entity) and asks. One rule serves the API checks and the owner and assignee pickers,
// so a picker lists exactly the people the API would accept.
//
// - Founder assigns anyone.
// - Finance, Accountant and PMO, when starting a lead (`create`), pick a Sales user with a department as its
//   owner, never themselves or a colleague.
// - Anyone else assigns themselves.
// - Sales may not assign to Marketing, even inside one shared department.
// - Within one department a person assigns at or below their own level: staff to same-level peers, managers to
//   staff and managers, heads to anyone in the department. Nobody assigns upward.
// - Marketing may hand to Sales, any level up to their own, when both belong to a department (a lead with an
//   owner who has no department would belong to no department).
// Sales and Marketing are told apart by role key, never by a department's name. A person holding both roles
// counts as Marketing for the hand-off, so they can reach Sales. A refusal carries a reason code for the 400
// message and the picker.
import {
  ACCESS_LEVEL_RANK,
  type AssignmentContext,
  type AssignmentDecision,
  type AssignmentParty,
  LEAD_INTAKE_ROLE_KEYS,
  MARKETING_ROLE_KEY,
  SALES_ROLE_KEY,
} from '@bos/contracts';

const holds = (party: AssignmentParty, role: string): boolean =>
  (party.roleKeys as readonly string[]).includes(role);

const rank = (party: AssignmentParty): number => ACCESS_LEVEL_RANK[party.level];

const isIntake = (party: AssignmentParty): boolean =>
  LEAD_INTAKE_ROLE_KEYS.some((role) => holds(party, role));

/** May `actor` hand work to `target`? */
export function decideAssignment(
  actor: AssignmentParty,
  target: AssignmentParty,
  context: AssignmentContext = 'reassign',
): AssignmentDecision {
  if (holds(actor, 'founder')) return { allowed: true, reason: 'founder' };

  if (context === 'create' && isIntake(actor)) {
    if (holds(target, SALES_ROLE_KEY)) {
      return target.departmentId === null
        ? { allowed: false, reason: 'no_department' }
        : { allowed: true, reason: 'intake_handoff' };
    }
    // Someone who only starts leads for Sales may not keep one; a person who also works leads falls through.
    if (!holds(actor, SALES_ROLE_KEY) && !holds(actor, MARKETING_ROLE_KEY)) {
      return { allowed: false, reason: 'sales_owner_required' };
    }
  }

  if (actor.userId === target.userId) return { allowed: true, reason: 'self' };

  if (
    holds(actor, SALES_ROLE_KEY) &&
    !holds(actor, MARKETING_ROLE_KEY) &&
    holds(target, MARKETING_ROLE_KEY) &&
    !holds(target, SALES_ROLE_KEY)
  ) {
    return { allowed: false, reason: 'reverse_handoff' };
  }

  if (actor.departmentId !== null && actor.departmentId === target.departmentId) {
    return rank(target) <= rank(actor)
      ? { allowed: true, reason: 'department' }
      : { allowed: false, reason: 'upward' };
  }

  if (holds(actor, MARKETING_ROLE_KEY) && holds(target, SALES_ROLE_KEY)) {
    if (actor.departmentId === null || target.departmentId === null) {
      return { allowed: false, reason: 'no_department' };
    }
    return rank(target) <= rank(actor)
      ? { allowed: true, reason: 'sales_handoff' }
      : { allowed: false, reason: 'upward' };
  }

  return {
    allowed: false,
    reason:
      actor.departmentId === null || target.departmentId === null
        ? 'no_department'
        : 'other_department',
  };
}

/** The candidates `actor` may hand work to, in their given order: what an owner or assignee picker lists. */
export function assignableTargets<T extends AssignmentParty>(
  actor: AssignmentParty,
  candidates: readonly T[],
  context: AssignmentContext = 'reassign',
): T[] {
  return candidates.filter((candidate) => decideAssignment(actor, candidate, context).allowed);
}

/**
 * The owner a new lead gets when the creator does not choose one and the creator may not own it: the Sales head.
 * With several heads the lowest user id wins, so the answer never depends on list order. NULL when no candidate
 * holds the Sales role at head level.
 */
export function defaultSalesOwner(candidates: readonly AssignmentParty[]): string | null {
  const heads = candidates
    .filter((candidate) => holds(candidate, SALES_ROLE_KEY) && candidate.level === 'head')
    .map((candidate) => candidate.userId)
    .sort();
  return heads[0] ?? null;
}
