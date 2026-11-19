// Who a lead, or the work on it, may be handed to. One rule for the owner select (LeadsService.owners), a lead's
// owner on create and edit, and the assignee of a lead follow-up or activity:
// - the person is an active staff member of the acting entity (not a portal user, not disabled, not a member of
//   another entity only);
// - the caller's crm.lead.write grant reaches a lead owned by that person (the same `can()` rule as a lead PATCH),
//   so an `own` grant can hand work only to the caller.
// A refusal is a 400 naming the field: the request names someone it may not, the record itself is fine.
import { idpOrgs, userEntities, users } from '@bos/db';
import { BadRequestException } from '@nestjs/common';
import { and, eq, type SQL } from 'drizzle-orm';

import { can, type Principal } from '../../platform/authz/can';
import type { DbTransaction } from '../../platform/db/tx';

type EntityScope = { tenantId: string; organizationId: string };

/** The active staff members of the acting entity (one of them when `userId` is named), with their membership roles. */
export function activeStaffOfEntity(tx: DbTransaction, scope: EntityScope, userId?: string) {
  const filters: SQL[] = [eq(users.tenantId, scope.tenantId), eq(users.status, 'active')];
  if (userId !== undefined) filters.push(eq(users.id, userId));
  return tx
    .select({
      userId: users.id,
      displayName: users.displayName,
      email: users.email,
      avatarDocumentId: users.avatarDocumentId,
      roleKeys: userEntities.roleKeys,
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

/** The caller's crm.lead.write grant reaches a lead of this entity owned by `userId`. */
export function mayAssignLead(principal: Principal, scope: EntityScope, userId: string): boolean {
  return can(principal, 'crm.lead.write', {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    ownerUserId: userId,
  }).allowed;
}

/** `userId` must be an active staff member of the acting entity; otherwise a 400 naming `field`. */
export async function assertActiveStaff(
  tx: DbTransaction,
  scope: EntityScope,
  userId: string,
  field: string,
): Promise<void> {
  const [found] = await activeStaffOfEntity(tx, scope, userId).limit(1);
  if (found === undefined) {
    throw new BadRequestException({
      code: 'bad_request',
      message: `${field} is not an active staff member of this entity`,
    });
  }
}

/**
 * `userId` may own a lead, or be given its follow-up, by this caller: an active staff member of the acting entity
 * whom the caller's grant reaches. Otherwise a 400 naming `field`.
 */
export async function assertLeadAssignee(
  tx: DbTransaction,
  principal: Principal,
  scope: EntityScope,
  userId: string,
  field: string,
): Promise<void> {
  await assertActiveStaff(tx, scope, userId, field);
  if (!mayAssignLead(principal, scope, userId)) {
    throw new BadRequestException({
      code: 'bad_request',
      message: `${field} cannot be someone else: your access covers only your own leads`,
    });
  }
}
