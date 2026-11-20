// Who may invite a customer's FIRST portal admin (F1-Q31, Kuu 2026-11-20): the customer's account owner
// (`customers.owner_user_id`), and only one of the customer's existing contacts. Later grants, once the customer
// has a portal user, keep the plain customer.write rule. One predicate serves the grant route (which refuses) and
// the customer detail read (which tells the workspace whether to offer the invite), so the two never disagree.
// No imports from the customers module: CustomersService reads this file, and the grant service reads that one.
import { idpOrgs, users } from '@bos/db';
import { and, eq } from 'drizzle-orm';

import type { Db, DbTransaction } from '../../platform/db/db.module';

/**
 * `ok` when the caller may invite now; `owner_only` when the customer has no portal user yet and the caller is not
 * its account owner; `owner_missing` when it has no portal user yet and no account owner at all.
 */
export type FirstAdminRule = 'ok' | 'owner_only' | 'owner_missing';

export function firstAdminRule(
  customer: { ownerUserId: string | null },
  callerUserId: string,
  hasPortalUser: boolean,
): FirstAdminRule {
  if (hasPortalUser) return 'ok';
  if (customer.ownerUserId === null) return 'owner_missing';
  return customer.ownerUserId === callerUserId ? 'ok' : 'owner_only';
}

/**
 * Whether the customer's portal org already mirrors a user (any status: an invited first admin counts, so a
 * re-sent invite is not a "first" grant). The org row alone is not enough: a grant that died after linking the
 * org leaves one with nobody in it.
 */
export async function customerHasPortalUser(
  db: Db | DbTransaction,
  tenantId: string,
  customerId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
    .where(
      and(
        eq(users.tenantId, tenantId),
        eq(idpOrgs.partyId, customerId),
        eq(idpOrgs.kind, 'customer'),
      ),
    )
    .limit(1);
  return row !== undefined;
}
