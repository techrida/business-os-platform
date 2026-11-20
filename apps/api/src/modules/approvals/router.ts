// The approval router: from a frozen workflow spec, the request's facts and who may approve what, it
// works out the ordered steps of an approval and why each one exists. Pure and synchronous, so the same
// inputs always give the same plan (preview and submit agree) and every rule is cheap to table-test.
// Serves the NFRs "approvals are auditable" (a reason per step) and "separation of duties" (the people
// in sodUserIds, such as the requester, can never be an approver of their own document).
import {
  DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE,
  type RoutePlan,
  type StepSpec,
  type WorkflowSpec,
} from '@bos/contracts';
import { formatMoney, type NumberSystems } from '@bos/locale';
import Decimal from 'decimal.js';

import { evaluate } from './conditions';

/** Who may approve a step. `eligible` already includes active delegates (see buildDirectory). */
export interface ApproverDirectory {
  /**
   * `exclude` drops people as if they were SoD for this one step: before their delegates are added (so
   * nobody stands in for them) and after.
   */
  eligible(step: StepSpec, exclude?: ReadonlySet<string>): string[];
  /** The approval_groups id for a group key; the plan carries ids, the spec carries keys. */
  groupIdOf?(key: string): string | undefined;
  /** The active head of a department of this entity, if it has one (department_head steps). */
  departmentHead?(departmentId: string): string | undefined;
}

/** Who decided the step at `seq`: the decider and, for a delegate, the approver they acted for. */
export interface StepDecision {
  seq: number;
  deciders: readonly string[];
}

interface Placed {
  spec: StepSpec;
  reason: string;
}

/**
 * Base steps first, then every rule whose `when` holds adds its step, in rule order:
 * - `end` appends;
 * - `{after: X}` inserts after X and after any step an earlier rule already put after X, so two rules
 *   "after X" keep their rule order;
 * - if X is a rule step whose rule did not fire, the step is appended at the end. Adding the approver
 *   late is safer than dropping them.
 * A rule-added step carries the rule's reason ("Founder approval because ..."): it says why the step
 * was added, which is what the approver and the audit trail need.
 *
 * `decisions` are the steps of this request already decided (rerouting an open request). Under
 * `distinctApprovers` the people who decided an earlier step, and their delegates acting for them, are
 * not eligible for a later one: act() would refuse them, so counting them would leave the step pending
 * with nobody able to decide it. A step left without anyone is blocked like any other.
 *
 * Under `distinctApprovers` the plan is also blocked when the steps not yet decided cannot each get a
 * different person (two Management steps with one Management user, AD8): it would otherwise stick after
 * the first decision. The first step left without its own person is the one marked blocked.
 */
export function route(
  spec: WorkflowSpec,
  facts: Record<string, unknown>,
  dir: ApproverDirectory,
  sodUserIds: readonly string[],
  decisions: readonly StepDecision[] = [],
): RoutePlan {
  const placed: Placed[] = spec.steps.map((s) => ({
    spec: s,
    reason: fillReason(s.reason, facts),
  }));
  // For each anchor X, the id of the last step inserted after it (initially X itself).
  const tailAfter = new Map<string, string>();

  for (const rule of spec.rules) {
    if (!evaluate(rule.when, facts)) continue;
    const entry: Placed = { spec: rule.add, reason: fillReason(rule.reason, facts) };
    if (rule.position === 'end') {
      placed.push(entry);
      continue;
    }
    const anchor = rule.position.after;
    const tailId = tailAfter.get(anchor) ?? anchor;
    const index = placed.findIndex((p) => p.spec.id === tailId);
    if (index === -1) {
      placed.push(entry);
    } else {
      placed.splice(index + 1, 0, entry);
      tailAfter.set(anchor, rule.add.id);
    }
  }

  const sod = new Set(sodUserIds);
  const steps: RoutePlan['steps'] = placed.map((p, i) => {
    const earlier = new Set(
      spec.distinctApprovers
        ? decisions.filter((d) => d.seq < i + 1).flatMap((d) => [...d.deciders])
        : [],
    );
    // A department_head step is planned as the user or role step it resolves to; the plan keeps the
    // kind and carries the resolved head (userId) or fallback role (roleKey).
    const target = resolveTarget(p.spec, facts, dir, sod);
    const eligibleUserIds = [...new Set(dir.eligible(target, earlier))].filter(
      (id) => !sod.has(id) && !earlier.has(id),
    );
    const groupId = target.group === undefined ? undefined : dir.groupIdOf?.(target.group);
    return {
      seq: i + 1,
      kind: p.spec.kind,
      ...(target.kind === 'role' && target.role !== undefined ? { roleKey: target.role } : {}),
      ...(target.kind === 'group' && groupId !== undefined ? { groupId } : {}),
      ...(target.kind === 'user' && target.user !== undefined ? { userId: target.user } : {}),
      reason: p.reason,
      eligibleUserIds,
      blocked: eligibleUserIds.length === 0,
    };
  });

  if (steps.length === 0) {
    // Nothing to approve would mean "approved by nobody": refuse instead of auto-approving.
    return { steps, blocked: true, blockReason: 'The workflow produced no approval steps' };
  }
  const first = steps.find((s) => s.blocked);
  if (first !== undefined) {
    return {
      steps,
      blocked: true,
      blockReason: `Step ${first.seq} (${describe(placed[first.seq - 1]!.spec)}) has no eligible approver after separation of duties`,
    };
  }
  if (spec.distinctApprovers) {
    // Decided steps are left out: their deciders are already kept off the later steps above.
    const decided = new Set(decisions.map((d) => d.seq));
    const unassigned = firstUnassignable(steps.filter((s) => !decided.has(s.seq)));
    if (unassigned !== undefined) {
      // The step itself is marked, so reroute (which reads the open steps) blocks it too.
      unassigned.blocked = true;
      return {
        steps,
        blocked: true,
        blockReason: `Step ${unassigned.seq} (${describe(placed[unassigned.seq - 1]!.spec)}) has no eligible approver distinct from the other steps' approvers`,
      };
    }
  }
  return { steps, blocked: false };
}

/**
 * Under distinctApprovers one person decides at most one step, so every open step needs its own person
 * from its eligible set (a system of distinct representatives). Bipartite matching with augmenting paths
 * (Kuhn), steps in seq order: the first step that cannot be given a person is returned, or undefined
 * when everyone can be placed. Routes have a handful of steps, so the simple search is plenty.
 */
function firstUnassignable<S extends { eligibleUserIds: readonly string[] }>(
  steps: readonly S[],
): S | undefined {
  const holder = new Map<string, number>();
  const assign = (step: number, seen: Set<string>): boolean => {
    for (const user of steps[step]!.eligibleUserIds) {
      if (seen.has(user)) continue;
      seen.add(user);
      const current = holder.get(user);
      if (current === undefined || assign(current, seen)) {
        holder.set(user, step);
        return true;
      }
    }
    return false;
  };
  return steps.find((_, i) => !assign(i, new Set()));
}

/**
 * A placeholder, with the currency code written just before it when there is one ("NPR {amountNpr}") and the
 * percent sign written just after it when there is one ("{effectiveDiscountPct}%").
 */
const PLACEHOLDER = /(?:\b(NPR|INR|USD) )?\{([A-Za-z_]\w*(?:\.\w+)*)\}(%)?/g;
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
/** D22: a percentage is shown with at most four decimals. */
const PERCENT_SCALE = 4;

/**
 * How an amount in a reason groups its digits (U15b-Q7). Western grouping for every currency, so a filled
 * amount reads like the limits the reason templates write next to it ("NPR 139,506,172.14 is above NPR
 * 1,000,000.00").
 */
const REASON_NUMBER_SYSTEMS: NumberSystems = {
  NPR: 'international',
  INR: 'international',
  USD: 'international',
};

/**
 * Fills `{fact}` placeholders in a reason ("Discount {effectiveDiscountPct}% exceeds permitted 12%")
 * with the request's own facts, so the approver sees the value that triggered the step.
 * - Only own properties of `facts` are read (never `constructor` or `__proto__`), and only strings,
 *   numbers and booleans are rendered: an object, array or null stays as the literal placeholder.
 * - An unknown placeholder stays literal rather than being rejected here: validating names needs the
 *   subject's fact list, which the frozen spec does not carry, and a typo must not stop an approval.
 * - A placeholder written right after a currency code ("NPR {amountNpr}") is an amount of money (U15b-Q7,
 *   D22): it is shown grouped, rounded half up to two decimals ("NPR 139,506,172.14"). Only the text is
 *   rounded; the facts the conditions compare stay exact.
 * - A placeholder written right before a percent sign ("{effectiveDiscountPct}%") is a percentage (D22): a
 *   value with more than four decimals is rounded half up to four ("14.285714..." reads "14.2857"); a shorter
 *   one keeps its written scale. Only the text is rounded, as for money.
 * - Other decimal facts are formatted with decimal.js, never through a float: a decimal string keeps its
 *   written scale ("12.50" stays "12.50") and a number never turns into an exponent ("1e21").
 * - One pass over the template, so a fact value containing `{other}` is not expanded again. The text
 *   is plain, so nothing is escaped.
 */
function fillReason(template: string, facts: Record<string, unknown>): string {
  return template.replace(
    PLACEHOLDER,
    (
      literal,
      currency: 'NPR' | 'INR' | 'USD' | undefined,
      path: string,
      percentSign: '%' | undefined,
    ) => {
      const prefix = currency === undefined ? '' : `${currency} `;
      const suffix = percentSign ?? '';
      let current: unknown = facts;
      for (const part of path.split('.')) {
        if (current === null || typeof current !== 'object') return literal;
        if (!Object.prototype.hasOwnProperty.call(current, part)) return literal;
        current = (current as Record<string, unknown>)[part];
      }
      let decimal: string | undefined;
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return literal;
        decimal = new Decimal(current).toFixed();
      } else if (typeof current === 'string' && DECIMAL_TEXT.test(current)) {
        const scale = current.includes('.') ? current.length - current.indexOf('.') - 1 : 0;
        decimal = new Decimal(current).toFixed(scale);
      }
      if (decimal !== undefined && currency !== undefined) {
        return `${formatMoney(decimal, currency, { numberSystems: REASON_NUMBER_SYSTEMS })}${suffix}`;
      }
      if (decimal !== undefined && percentSign !== undefined) {
        const exact = new Decimal(decimal);
        if (exact.decimalPlaces() > PERCENT_SCALE) {
          decimal = exact.toFixed(PERCENT_SCALE, Decimal.ROUND_HALF_UP);
        }
      }
      if (decimal !== undefined) return `${prefix}${decimal}${suffix}`;
      if (typeof current === 'string') return `${prefix}${current}${suffix}`;
      return typeof current === 'boolean' ? `${prefix}${String(current)}${suffix}` : literal;
    },
  );
}

/**
 * The user or role step a department_head step stands for (AD11): the active head of the department in
 * the `departmentId` fact, unless the head is an SoD person (the requester) or there is none; then its
 * `fallbackRole`. Other kinds are returned unchanged. A fallback role with nobody in it leaves the step
 * without an approver, which blocks the plan like any other empty step.
 */
export function resolveTarget(
  step: StepSpec,
  facts: Record<string, unknown>,
  dir: Pick<ApproverDirectory, 'departmentHead'>,
  sod: ReadonlySet<string>,
): StepSpec {
  if (step.kind !== 'department_head') return step;
  const departmentId = Object.prototype.hasOwnProperty.call(facts, 'departmentId')
    ? facts['departmentId']
    : undefined;
  const head =
    typeof departmentId === 'string' && departmentId !== ''
      ? dir.departmentHead?.(departmentId)
      : undefined;
  const base = { id: step.id, reason: step.reason };
  if (head !== undefined && !sod.has(head)) return { ...base, kind: 'user', user: head };
  return {
    ...base,
    kind: 'role',
    role: step.fallbackRole ?? DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE,
  };
}

function describe(step: StepSpec): string {
  if (step.kind === 'department_head') {
    return `department head, fallback role ${step.fallbackRole ?? DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE}`;
  }
  if (step.kind === 'role') return `role ${step.role ?? '?'}`;
  if (step.kind === 'group') return `group ${step.group ?? '?'}`;
  return `user ${step.user ?? '?'}`;
}

// ---------------------------------------------------------------------------------------------------
// The directory: who holds a role, who is in a group, and who stands in for whom right now.

export interface DelegationRow {
  fromUserId: string;
  toUserId: string;
  startsAt: Date;
  endsAt: Date;
  documentType: string | null;
  revokedAt: Date | null;
}

/** Everything the router needs to know about people, loaded by the service before routing. */
export interface DirectoryData {
  /** Role key → user ids holding it (the app.user_roles mirror of the ZITADEL grants). */
  roleMembers: ReadonlyMap<string, readonly string[]>;
  /** Group key → its id and member user ids. */
  groups: ReadonlyMap<string, { id: string; memberIds: readonly string[] }>;
  delegations: readonly DelegationRow[];
  /**
   * Active users among the ones user steps name. When given, a named user outside it has no approver.
   * Optional: pure routing tests leave it out, and the service omits it when no user is named (undefined
   * means no restriction, for user and department-head steps alike).
   */
  activeUserIds?: ReadonlySet<string>;
  /**
   * Department id → its head (app.departments.head_user_id), for department_head steps. A head outside
   * `activeUserIds` (when given) counts as no head. Optional; without it every such step falls back.
   */
  departmentHeads?: ReadonlyMap<string, string>;
}

export interface BuiltDirectory extends ApproverDirectory {
  /** The step's own approvers (role, group or user), minus `sodUserIds`, without delegates. */
  direct(step: StepSpec): string[];
  /**
   * Whether `userId` may act on the step, and for whom: `onBehalfOf` is null when they are a direct
   * approver, otherwise the approver who delegated to them (one outside `preferNot` when possible).
   */
  resolveActor(
    step: StepSpec,
    userId: string,
    preferNot?: ReadonlySet<string>,
  ): { eligible: boolean; onBehalfOf: string | null };
}

/** A delegation counts on [starts_at, ends_at), when not revoked, and for its document type (or all). */
export function delegationActive(d: DelegationRow, now: Date, documentType: string): boolean {
  return (
    d.revokedAt === null &&
    d.startsAt.getTime() <= now.getTime() &&
    now.getTime() < d.endsAt.getTime() &&
    (d.documentType === null || d.documentType === documentType)
  );
}

/**
 * Builds the directory for one routing or acting moment. SoD users are removed *before* their
 * delegates are added, so nobody approves on the requester's behalf, and removed again after, so a
 * requester who is someone else's delegate cannot slip back in.
 */
export function buildDirectory(
  data: DirectoryData,
  opts: { now: Date; documentType: string; sodUserIds?: readonly string[] },
): BuiltDirectory {
  const sod = new Set(opts.sodUserIds ?? []);
  const active = data.delegations.filter((d) => delegationActive(d, opts.now, opts.documentType));

  const members = (step: StepSpec): string[] => {
    if (step.kind === 'role') return [...(data.roleMembers.get(step.role ?? '') ?? [])];
    if (step.kind === 'group') return [...(data.groups.get(step.group ?? '')?.memberIds ?? [])];
    if (step.user === undefined) return [];
    return data.activeUserIds === undefined || data.activeUserIds.has(step.user) ? [step.user] : [];
  };

  const direct = (step: StepSpec): string[] => [
    ...new Set(members(step).filter((id) => !sod.has(id))),
  ];

  return {
    direct,
    eligible(step, exclude) {
      const out = (id: string) => sod.has(id) || exclude?.has(id) === true;
      const base = direct(step).filter((id) => !out(id));
      const baseSet = new Set(base);
      const delegates = active.filter((d) => baseSet.has(d.fromUserId)).map((d) => d.toUserId);
      return [...new Set([...base, ...delegates])].filter((id) => !out(id));
    },
    groupIdOf: (key) => data.groups.get(key)?.id,
    departmentHead(departmentId) {
      const head = data.departmentHeads?.get(departmentId);
      if (head === undefined) return undefined;
      return data.activeUserIds === undefined || data.activeUserIds.has(head) ? head : undefined;
    },
    resolveActor(step, userId, preferNot) {
      if (sod.has(userId)) return { eligible: false, onBehalfOf: null };
      const base = direct(step);
      if (base.includes(userId)) return { eligible: true, onBehalfOf: null };
      const principals = active
        .filter((d) => d.toUserId === userId && base.includes(d.fromUserId))
        .map((d) => d.fromUserId);
      if (principals.length === 0) return { eligible: false, onBehalfOf: null };
      const preferred = principals.find((p) => !preferNot?.has(p)) ?? principals[0]!;
      return { eligible: true, onBehalfOf: preferred };
    },
  };
}
