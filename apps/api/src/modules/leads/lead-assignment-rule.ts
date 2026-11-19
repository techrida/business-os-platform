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
//
// The entity's stored rule (U20b, `loadAssignmentConfig`) replaces the D50 defaults inside a department (staff:
// same-level peers, only themselves or anyone at or below; managers and heads: at or below, or only themselves and
// people below them) and lists the department hand-overs. Under a stored list, a Sales user handing to Marketing
// with no pair that covers it still reads `reverse_handoff`, so the 400 names the direction the hand-over runs.
import {
  ACCESS_LEVEL_RANK,
  type AssignmentContext,
  type AssignmentDecision,
  type AssignmentDenyReason,
  type AssignmentParty,
  LEAD_INTAKE_ROLE_KEYS,
  type ManagerAssignmentRule,
  MARKETING_ROLE_KEY,
  SALES_ROLE_KEY,
  type StaffAssignmentRule,
} from '@bos/contracts';

/**
 * Optional tenant/entity policy for the assignment rule (U20b). When omitted, the built-in D50
 * defaults apply unchanged. No combination of options ever permits assigning upward.
 */
export interface AssignmentRuleConfig {
  /** Within-department rule for staff (default: `self_and_peers`). */
  staff?: StaffAssignmentRule;
  /** Within-department rule for managers (default: `any_at_or_below`). */
  managers?: ManagerAssignmentRule;
  /**
   * Explicit directed cross-department hand-over pairs (`fromDepartmentId` -> `toDepartmentId`).
   * When omitted, the built-in Marketing -> Sales role hand-off and Sales -> Marketing block apply.
   * When provided (including an empty array), only these pairs allow cross-department assignment.
   */
  handOvers?: readonly { fromDepartmentId: string; toDepartmentId: string }[];
}

const holds = (party: AssignmentParty, role: string): boolean =>
  (party.roleKeys as readonly string[]).includes(role);

const rank = (party: AssignmentParty): number => ACCESS_LEVEL_RANK[party.level];

const isIntake = (party: AssignmentParty): boolean =>
  LEAD_INTAKE_ROLE_KEYS.some((role) => holds(party, role));

/**
 * Why `actor` may not hand work to `target` by level inside a department or across a hand-over, or null when the
 * level allows it. Nobody assigns upward, whatever the stored rule says; the stored rule can only narrow further.
 */
function levelRefusal(
  actor: AssignmentParty,
  target: AssignmentParty,
  staffRule: StaffAssignmentRule,
  managersRule: ManagerAssignmentRule,
): AssignmentDenyReason | null {
  if (rank(target) > rank(actor)) return 'upward';
  if (actor.level === 'staff' && staffRule === 'self_only') return 'self_only';
  // Managers and heads limited to "themselves and people below their level": a peer at their own level is refused.
  if (actor.level !== 'staff' && managersRule === 'self_and_staff' && rank(target) >= rank(actor)) {
    return 'same_level';
  }
  return null;
}

/** The level check as a decision: allowed with `reason`, or refused with the level's reason. */
function byLevel(
  actor: AssignmentParty,
  target: AssignmentParty,
  staffRule: StaffAssignmentRule,
  managersRule: ManagerAssignmentRule,
  reason: 'department' | 'sales_handoff',
): AssignmentDecision {
  const refusal = levelRefusal(actor, target, staffRule, managersRule);
  return refusal === null ? { allowed: true, reason } : { allowed: false, reason: refusal };
}

/** A Sales user (not also Marketing) handing to a Marketing user (not also Sales): the direction D50 refuses. */
const isReverseHandOff = (actor: AssignmentParty, target: AssignmentParty): boolean =>
  holds(actor, SALES_ROLE_KEY) &&
  !holds(actor, MARKETING_ROLE_KEY) &&
  holds(target, MARKETING_ROLE_KEY) &&
  !holds(target, SALES_ROLE_KEY);

/** May `actor` hand work to `target`? */
export function decideAssignment(
  actor: AssignmentParty,
  target: AssignmentParty,
  context: AssignmentContext = 'reassign',
  config?: AssignmentRuleConfig,
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

  const staffRule: StaffAssignmentRule = config?.staff ?? 'self_and_peers';
  const managersRule: ManagerAssignmentRule = config?.managers ?? 'any_at_or_below';
  const explicitHandOvers = config?.handOvers;

  if (explicitHandOvers === undefined && isReverseHandOff(actor, target)) {
    return { allowed: false, reason: 'reverse_handoff' };
  }

  if (actor.departmentId !== null && actor.departmentId === target.departmentId) {
    return byLevel(actor, target, staffRule, managersRule, 'department');
  }

  if (explicitHandOvers !== undefined) {
    if (actor.departmentId === null || target.departmentId === null) {
      return { allowed: false, reason: 'no_department' };
    }
    const matched = explicitHandOvers.some(
      (pair) =>
        pair.fromDepartmentId === actor.departmentId && pair.toDepartmentId === target.departmentId,
    );
    if (!matched) {
      return {
        allowed: false,
        reason: isReverseHandOff(actor, target) ? 'reverse_handoff' : 'other_department',
      };
    }
    return byLevel(actor, target, staffRule, managersRule, 'sales_handoff');
  }

  if (holds(actor, MARKETING_ROLE_KEY) && holds(target, SALES_ROLE_KEY)) {
    if (actor.departmentId === null || target.departmentId === null) {
      return { allowed: false, reason: 'no_department' };
    }
    return byLevel(actor, target, staffRule, managersRule, 'sales_handoff');
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
  config?: AssignmentRuleConfig,
): T[] {
  return candidates.filter(
    (candidate) => decideAssignment(actor, candidate, context, config).allowed,
  );
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
