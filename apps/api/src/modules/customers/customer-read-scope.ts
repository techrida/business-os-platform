// The SQL twin of can() on a customer: which rows of `customers` a principal may read (or otherwise act on).
// A customer has no organization_id, so scoped() and scopeWhereFor() (which filter on it) do not apply; this is
// the predicate CustomersService lists with, exported so another module (the lead duplicate hint) can filter
// customers in the same WHERE before its LIMIT instead of checking can() row by row afterwards.
import { type Permission } from '@bos/contracts';
import { type customers } from '@bos/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { type Principal } from '../../platform/authz/can';

/** The columns the predicate reads: the `customers` table itself, or an alias of it. */
export type CustomerScopeColumns = Pick<typeof customers, 'tenantId' | 'id' | 'ownerUserId'>;

/**
 * The customers `p` may `action`, as SQL: the twin of can() for a record that names no entity. `all` is the
 * whole tenant for staff and the caller's own company for a portal user; `own` is the owner column. A customer
 * has no department column, so `department` (cumulative: own records count wherever they sit) reaches the
 * caller's own customers and nothing more, as can() does with a ref that names no department (review R2).
 * `assigned` reaches nothing: no assignment hands a customer over. Anything else (no grant, an unknown scope,
 * an inactive user) matches nothing.
 *
 * `tenantId` defaults to the principal's tenant; CustomersService passes the request scope's tenant. Use the
 * result ANDed into a WHERE: a customer with no owner makes the `own` branch NULL, not false.
 */
export function customerVisibleWhere(
  p: Principal,
  table: CustomerScopeColumns,
  action: Permission = 'customer.read',
  tenantId: string = p.tenantId,
): SQL {
  const none = sql`false`;
  if (p.status !== 'active') return none;
  const inTenant = eq(table.tenantId, tenantId);
  const ownCompany = (): SQL =>
    p.orgKind === 'customer' && p.partyId !== null && p.partyId !== ''
      ? (and(inTenant, eq(table.id, p.partyId)) as SQL)
      : none;
  switch (p.grants.get(action)) {
    case 'all':
      return p.orgKind === 'staff' ? inTenant : ownCompany();
    case 'own':
    case 'department':
      return and(inTenant, eq(table.ownerUserId, p.userId)) as SQL;
    case 'customer_org':
      return ownCompany();
    default:
      return none;
  }
}
