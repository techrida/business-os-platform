// Who a lead, or the work on it, may be handed to.
//
// The D50 rule (`assertAssignable`, `assignableParties`) decides the owner of a lead on create and edit and the
// owner select (LeadsService.owners), and is exported for the follow-up assignee. A person qualifies when they
// - are an active staff member of the acting entity (not a portal user, not disabled, not a member of another
//   entity only);
// - pass the assignment rule (lead-assignment-rule.ts) under the entity's stored rule for the area;
// - can read the record the work is about with their live grants (dead-end #21): work given to someone who cannot
//   open it is stranded. Any scope counts, `assigned` included, because holding the work is what reaches it.
// - for an owner, when the area names one (`ownerWrite`, leads: `crm.lead.write`), also hold that write at some scope
//   with their live grants: a role that never edits the record (Management) never owns it.
// A refusal is a 400 naming the field, with the rule's code in `details.assignmentReason`: the request names someone
// it may not, the record itself is fine.
import {
  ASSIGNMENT_DENY_MESSAGES,
  type AssignmentAreaKey,
  type AssignmentContext,
  type AssignmentDenyReason,
  type AssignmentParty,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
} from '@bos/contracts';
import { idpOrgs, userEntities, userRoles, users } from '@bos/db';
import { BadRequestException } from '@nestjs/common';
import { and, eq, inArray, type SQL } from 'drizzle-orm';

import type { Principal } from '../../platform/authz/can';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { DbTransaction } from '../../platform/db/tx';
import { loadAssignmentConfig, toAssignmentRuleConfig } from '../access-settings/assignment-config';
import { departmentNames, roleLine } from '../../platform/users/person-role';
import { type AssignmentRuleConfig, decideAssignment } from './lead-assignment-rule';

type EntityScope = { tenantId: string; organizationId: string };

const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_KEYS);

/**
 * The active staff members of the acting entity (one of them when `userId` is named), with the roles, department
 * and level of their membership in it.
 */
export function activeStaffOfEntity(tx: DbTransaction, scope: EntityScope, userId?: string) {
  const filters: SQL[] = [eq(users.tenantId, scope.tenantId), eq(users.status, 'active')];
  if (userId !== undefined) filters.push(eq(users.id, userId));
  return tx
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarDocumentId: users.avatarDocumentId,
      jobTitle: userEntities.jobTitle,
      roleKeys: userEntities.roleKeys,
      departmentId: userEntities.departmentId,
      level: userEntities.level,
    })
    .from(users)
    .innerJoin(
      idpOrgs,
      and(
        eq(idpOrgs.tenantId, users.tenantId),
        eq(idpOrgs.id, users.idpOrgId),
        eq(idpOrgs.kind, 'staff'),
      ),
    )
    .innerJoin(
      userEntities,
      and(
        eq(userEntities.tenantId, users.tenantId),
        eq(userEntities.userId, users.id),
        eq(userEntities.organizationId, scope.organizationId),
      ),
    )
    .where(and(...filters));
}

/** An active staff member as the assignment rule sees them, plus what a picker shows. */
export interface AssignmentCandidate extends AssignmentParty {
  displayName: string | null;
  email: string | null;
  avatarDocumentId: string | null;
  /** What a picker shows after the name: job title and department (BOS-UI-001). */
  role?: string | null;
}

/**
 * The active staff of the acting entity (only `userIds` when given) as assignment parties: roles are the user's
 * roles narrowed by the membership (as `UsersStore.userIdsWithRole` does; NULL keeps them all), department and
 * level are the membership's. Two queries whatever the number of people.
 */
export async function loadAssignmentParties(
  tx: DbTransaction,
  scope: EntityScope,
  userIds?: readonly string[],
): Promise<AssignmentCandidate[]> {
  if (userIds?.length === 0) return [];
  const staff =
    userIds?.length === 1
      ? await activeStaffOfEntity(tx, scope, userIds[0])
      : (await activeStaffOfEntity(tx, scope)).filter(
          (row) => userIds === undefined || userIds.includes(row.userId),
        );
  if (staff.length === 0) return [];
  const roleRows = await tx
    .select({ userId: userRoles.userId, roleKey: userRoles.roleKey })
    .from(userRoles)
    .where(
      and(
        eq(userRoles.tenantId, scope.tenantId),
        inArray(
          userRoles.userId,
          staff.map((row) => row.userId),
        ),
      ),
    );
  const rolesOf = new Map<string, RoleKey[]>();
  for (const { userId, roleKey } of roleRows) {
    // A role key this build does not know grants nothing, so it plays no part in the rule either.
    if (!ROLE_KEY_SET.has(roleKey)) continue;
    rolesOf.set(userId, [...(rolesOf.get(userId) ?? []), roleKey as RoleKey]);
  }
  const deptNames = await departmentNames(
    tx,
    scope,
    staff.map((row) => row.departmentId),
  );
  return staff.map((row) => ({
    userId: row.userId,
    roleKeys: (rolesOf.get(row.userId) ?? []).filter(
      (role) => row.roleKeys === null || row.roleKeys.includes(role),
    ),
    departmentId: row.departmentId,
    level: row.level,
    displayName: row.displayName,
    email: row.email,
    avatarDocumentId: row.avatarDocumentId,
    role: roleLine(
      row.jobTitle,
      row.departmentId === null ? null : (deptNames.get(row.departmentId) ?? null),
    ),
  }));
}

/** The caller as the assignment rule sees them: the request's roles, department and level in the acting entity. */
export function actorParty(principal: Principal): AssignmentParty {
  return {
    userId: principal.userId,
    roleKeys: principal.roles,
    departmentId: principal.departmentId,
    level: principal.level ?? 'staff',
  };
}

/**
 * The entity's stored rule for `area` (or the D50 defaults when none is stored), read on first use and then
 * remembered: a self-assignment never needs it, and a picker asks for it once for every candidate.
 */
export function storedAssignmentRule(
  tx: DbTransaction,
  scope: EntityScope,
  area: AssignmentAreaKey = 'leads',
): () => Promise<AssignmentRuleConfig | undefined> {
  let loaded: Promise<AssignmentRuleConfig | undefined> | undefined;
  return () =>
    (loaded ??= loadAssignmentConfig(tx, scope).then((rules) =>
      toAssignmentRuleConfig(
        rules.find((rule) => rule.area === area),
        true,
      ),
    ));
}

/** What a hand-over is checked against: the rule's context and stored rule, and the subject's read permission. */
export interface AssignmentCheck {
  roleCache: RoleCache;
  context: AssignmentContext;
  rule: () => Promise<AssignmentRuleConfig | undefined>;
  /** The read permission of the record the work is about, which the target must hold at some scope (#21). */
  subjectRead: Permission;
  /**
   * The write permission an owner must also hold at some scope, so a role that never edits the record never owns it
   * (Management reads every lead and writes none). Checked for the owner field and the owner pickers only; absent,
   * an owner needs the read alone.
   */
  ownerWrite?: Permission;
}

/** The 400 for a refused hand-over: the field and the rule's message, and the code for a client to switch on. */
export function assignmentRefused(
  field: string,
  reason: AssignmentDenyReason,
): BadRequestException {
  return new BadRequestException({
    code: 'bad_request',
    message: `${field} ${ASSIGNMENT_DENY_MESSAGES[reason]}`,
    details: { assignmentReason: reason },
  });
}

/** Whether `party`'s live grants in this tenant (roles and level, RoleCache) hold `permission` at any scope. */
export async function partyHolds(
  roleCache: RoleCache,
  scope: EntityScope,
  party: AssignmentParty,
  permission: Permission,
  // An owner needs a read that reaches the records they own: `assigned` reaches only records with a follow-up on them
  // (#21), so a lead handed to such a person would vanish from their own list.
  asOwner = false,
): Promise<boolean> {
  const grants = await roleCache.grantsFor(
    scope.tenantId,
    scope.organizationId,
    party.roleKeys,
    party.level,
  );
  const held = grants.get(permission);
  return held !== undefined && !(asOwner && held === 'assigned');
}

/** Whether `principal` themselves holds `permission`, with the same owner rule as `partyHolds`. */
function selfHolds(principal: Principal, permission: Permission, asOwner: boolean): boolean {
  const held = principal.grants.get(permission);
  return held !== undefined && !(asOwner && held === 'assigned');
}

/** Whether the caller themselves may own the record: the subject read and, when named, the owner write. */
function selfMayOwn(principal: Principal, check: AssignmentCheck): boolean {
  return (
    selfHolds(principal, check.subjectRead, true) &&
    (check.ownerWrite === undefined || principal.grants.has(check.ownerWrite))
  );
}

/** Whether `party` may own the record by their live grants: the subject read and, when named, the owner write. */
async function partyMayOwn(
  roleCache: RoleCache,
  scope: EntityScope,
  party: AssignmentParty,
  check: AssignmentCheck,
): Promise<boolean> {
  if (!(await partyHolds(roleCache, scope, party, check.subjectRead, true))) return false;
  return (
    check.ownerWrite === undefined ||
    (await partyHolds(roleCache, scope, party, check.ownerWrite, false))
  );
}

/**
 * `userId` may be handed this work by the caller: active staff of the acting entity, allowed by the rule, and able
 * to read the subject. Otherwise a 400 naming `field` (`assignmentRefused`). The caller themselves is taken from the
 * request (the tenancy interceptor already found their membership), so naming yourself needs no directory read.
 */
export async function assertAssignable(
  tx: DbTransaction,
  principal: Principal,
  scope: EntityScope,
  userId: string,
  field: string,
  check: AssignmentCheck,
): Promise<void> {
  const actor = actorParty(principal);
  if (userId === principal.userId) {
    const decision = decideAssignment(actor, actor, check.context);
    if (!decision.allowed) throw assignmentRefused(field, decision.reason);
    const allowed =
      field === 'ownerUserId'
        ? selfMayOwn(principal, check)
        : selfHolds(principal, check.subjectRead, false);
    if (!allowed) throw assignmentRefused(field, 'cannot_read_subject');
    return;
  }
  const [target] = await loadAssignmentParties(tx, scope, [userId]);
  if (target === undefined) throw assignmentRefused(field, 'not_active_staff');
  const decision = decideAssignment(actor, target, check.context, await check.rule());
  if (!decision.allowed) throw assignmentRefused(field, decision.reason);
  const allowed =
    field === 'ownerUserId'
      ? await partyMayOwn(check.roleCache, scope, target, check)
      : await partyHolds(check.roleCache, scope, target, check.subjectRead, false);
  if (!allowed) throw assignmentRefused(field, 'cannot_read_subject');
}

/**
 * The people the caller may hand this work to, in directory order: what an owner or assignee picker lists, and
 * exactly whom `assertAssignable` accepts for the owner (the rule's `assignableTargets`, narrowed to those who can
 * read the subject and, when the check names one, hold the owner write).
 */
export async function assignableParties(
  tx: DbTransaction,
  principal: Principal,
  scope: EntityScope,
  check: AssignmentCheck,
): Promise<AssignmentCandidate[]> {
  const actor = actorParty(principal);
  const config = await check.rule();
  const out: AssignmentCandidate[] = [];
  for (const candidate of await loadAssignmentParties(tx, scope)) {
    if (candidate.userId === principal.userId) {
      if (decideAssignment(actor, actor, check.context).allowed && selfMayOwn(principal, check)) {
        out.push(candidate);
      }
      continue;
    }
    if (!decideAssignment(actor, candidate, check.context, config).allowed) continue;
    if (await partyMayOwn(check.roleCache, scope, candidate, check)) out.push(candidate);
  }
  return out;
}
