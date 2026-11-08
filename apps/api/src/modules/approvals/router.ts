// The approval router: from a frozen workflow spec, the request's facts and who may approve what, it
// works out the ordered steps of an approval and why each one exists. Pure and synchronous, so the same
// inputs always give the same plan (preview and submit agree) and every rule is cheap to table-test.
// Serves the NFRs "approvals are auditable" (a reason per step) and "separation of duties" (the people
// in sodUserIds, such as the requester, can never be an approver of their own document).
import type { RoutePlan, StepSpec, WorkflowSpec } from '@bos/contracts';

import { evaluate } from './conditions';

/** Who may approve a step. `eligible` already includes active delegates (see buildDirectory). */
export interface ApproverDirectory {
  eligible(step: StepSpec): string[];
  /** The approval_groups id for a group key; the plan carries ids, the spec carries keys. */
  groupIdOf?(key: string): string | undefined;
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
 */
export function route(
  spec: WorkflowSpec,
  facts: Record<string, unknown>,
  dir: ApproverDirectory,
  sodUserIds: readonly string[],
): RoutePlan {
  const placed: Placed[] = spec.steps.map((s) => ({ spec: s, reason: s.reason }));
  // For each anchor X, the id of the last step inserted after it (initially X itself).
  const tailAfter = new Map<string, string>();

  for (const rule of spec.rules) {
    if (!evaluate(rule.when, facts)) continue;
    const entry: Placed = { spec: rule.add, reason: rule.reason };
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
    const eligibleUserIds = [...new Set(dir.eligible(p.spec))].filter((id) => !sod.has(id));
    const groupId = p.spec.group === undefined ? undefined : dir.groupIdOf?.(p.spec.group);
    return {
      seq: i + 1,
      kind: p.spec.kind,
      ...(p.spec.kind === 'role' && p.spec.role !== undefined ? { roleKey: p.spec.role } : {}),
      ...(p.spec.kind === 'group' && groupId !== undefined ? { groupId } : {}),
      ...(p.spec.kind === 'user' && p.spec.user !== undefined ? { userId: p.spec.user } : {}),
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
  if (first === undefined) return { steps, blocked: false };
  return {
    steps,
    blocked: true,
    blockReason: `Step ${first.seq} (${describe(placed[first.seq - 1]!.spec)}) has no eligible approver after separation of duties`,
  };
}

function describe(step: StepSpec): string {
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
   * Optional so pure routing tests can leave it out; the service always loads it.
   */
  activeUserIds?: ReadonlySet<string>;
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
    eligible(step) {
      const base = direct(step);
      const baseSet = new Set(base);
      const delegates = active.filter((d) => baseSet.has(d.fromUserId)).map((d) => d.toUserId);
      return [...new Set([...base, ...delegates])].filter((id) => !sod.has(id));
    },
    groupIdOf: (key) => data.groups.get(key)?.id,
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
