// What services call to enforce authz inside a handler: `assert()` for one record, `scopeWhere()` to
// filter a list query to the same rows `can()` would allow, and `invalidate()` after a role change.
// Serves the NFR "authorization is deny-by-default" (P1 plan §1, k-authz; §6.2): a list query and a
// record check give the same answer, so a user cannot see a row in a list that they could not open.
import type { Permission } from '@bos/contracts';
import { authzVersions, type Scoped, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { DB, type Db } from '../db/db.module';
import { systemActor, withTx } from '../db/tx';
import { can } from './can';
import { type Principal, type ResourceRef, type ScopableTable, principal } from './principal';
import { RoleCache } from './role-cache';

// The @bos/db index exports `Scoped` but not its counterparty helper types, so derive them here.
type CounterpartyKind = Parameters<Scoped['forCounterparty']>[1];
type AnyCounterpartyTable = Parameters<Scoped['forCounterparty']>[0];

/** Matches no row. Every "cannot reach" case returns this, so the default is an empty list. */
const NOTHING: SQL = sql`false`;

/** The counterparty column of `table` for the principal's org kind; staff have none (see can.ts). */
function counterpartyColumn(
  p: Principal,
  table: ScopableTable,
): { kind: CounterpartyKind; column: AnyPgColumn } | undefined {
  if (p.orgKind === 'customer' && table.customerOrganizationId !== undefined) {
    return { kind: 'customer', column: table.customerOrganizationId };
  }
  if (p.orgKind === 'vendor' && table.vendorOrganizationId !== undefined) {
    return { kind: 'vendor', column: table.vendorOrganizationId };
  }
  return undefined;
}

/**
 * The SQL twin of `can(p, action, r)` for every row `r` of `table`: a row matches exactly when
 * `can()` would allow it. Each branch mirrors `inScope()` in can.ts; a column the table lacks is
 * treated like a missing `ResourceRef` field, which never matches.
 *
 * Separation of duties is not expressed here (it depends on who prepared each record, not on a
 * column), so an SoD action still needs `assert()` on the chosen record.
 */
export function scopeWhereFor(p: Principal, table: ScopableTable, action: Permission): SQL {
  if (p.status !== 'active') return NOTHING;
  const scope = p.grants.get(action);
  if (scope === undefined) return NOTHING;

  const s = scoped({ tenantId: p.tenantId, organizationId: p.organizationId });
  switch (scope) {
    case 'own':
      if (table.ownerUserId === undefined) return NOTHING;
      return s.where(table, eq(table.ownerUserId, p.userId));
    case 'department':
      // No department means no department scope; NULL = NULL would not match anyway, but be explicit.
      if (p.departmentId === null || table.departmentId === undefined) return NOTHING;
      return s.where(table, eq(table.departmentId, p.departmentId));
    case 'customer_org': {
      // The portal rule (ADR 0017): the counterparty column, never organization_id.
      const counterparty = counterpartyColumn(p, table);
      if (counterparty === undefined) return NOTHING;
      // Safe cast: counterpartyColumn() returned only because the table has this kind's column.
      return s.forCounterparty(table as unknown as AnyCounterpartyTable, counterparty.kind);
    }
    case 'all': {
      const counterparty = counterpartyColumn(p, table);
      // Staff, or a table with no counterparty column: rows my org owns.
      if (counterparty === undefined) return s.where(table);
      return and(
        eq(table.tenantId, p.tenantId),
        or(eq(table.organizationId, p.organizationId), eq(counterparty.column, p.organizationId)),
      ) as SQL;
    }
    default:
      // An unknown scope string from the database grants nothing, as in can().
      return NOTHING;
  }
}

@Injectable()
export class AuthzService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly roleCache: RoleCache,
  ) {}

  /**
   * Throws 403 unless the current principal may do `action` (on `r`, when given). The body's
   * `reason` is the deny reason; `ErrorBodyFilter` copies it into the response when it is one of
   * the contract's `ERROR_REASONS`.
   */
  assert(action: Permission, r?: ResourceRef): void {
    const decision = can(principal(), action, r);
    if (!decision.allowed) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: decision.reason,
      });
    }
  }

  /** A `.where()` condition limiting `table` to the rows the current principal may `action`. */
  scopeWhere(table: ScopableTable, action: Permission): SQL {
    return scopeWhereFor(principal(), table, action);
  }

  /**
   * Bumps the org's `authz_versions` row, so every api instance reloads its role rows within 5 s
   * (R11), and this instance at once. Call it after the `role_permissions` change has committed:
   * a reload between this bump and that commit would cache the old rows under the new version.
   */
  async invalidate(tenantId: string, organizationId: string): Promise<void> {
    await withTx(
      this.db,
      { tenantId, organizationId },
      systemActor('authz.invalidate'),
      async (tx) => {
        await tx
          .insert(authzVersions)
          .values({ tenantId, organizationId, version: 1 })
          .onConflictDoUpdate({
            target: [authzVersions.tenantId, authzVersions.organizationId],
            set: { version: sql`${authzVersions.version} + 1`, updatedAt: sql`now()` },
          });
      },
    );
    this.roleCache.forget(tenantId, organizationId);
  }
}
