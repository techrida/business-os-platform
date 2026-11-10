import { and, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/** Who is asking. Both ids are required: a tenant alone is not enough to read an organization's rows. */
export interface Scope {
  tenantId: string;
  organizationId: string;
}

/** Any Drizzle table that has the two tenancy columns, under these property names. */
export type ScopedTable = PgTable & { tenantId: AnyPgColumn; organizationId: AnyPgColumn };

export interface Scoped {
  readonly scope: Readonly<Scope>;
  /** `tenant_id = $1 AND organization_id = $2`, and `extra` too when given. Pass the result to .where(). */
  where: (table: ScopedTable, extra?: SQL) => SQL;
  /** The row (or rows) with both ids filled in. Pass the result to .values(). */
  values: <R extends object>(row: R) => R & Scope;
}

/**
 * Builds the two helpers every repository must use, so that a query cannot forget the tenant or the
 * organization. P1 repositories never write `eq(table.tenantId, ...)` by hand:
 *
 *   const s = scoped(ctx());
 *   await db.select().from(invoices).where(s.where(invoices, eq(invoices.status, 'open')));
 *   await db.insert(invoices).values(s.values({ number: 'INV-1', status: 'open' }));
 *
 * It takes the ids explicitly and infers nothing: which organization a customer's query is filtered on is
 * an open decision (ADR 0006, risk R9). Callers pass the ids from the request context.
 */
export function scoped(scope: Scope): Scoped {
  if (scope.tenantId === '' || scope.organizationId === '') {
    // An empty id would match no rows (or, worse, be mistaken for "no filter" by a later refactor).
    throw new Error('scoped() needs a non-empty tenantId and organizationId');
  }
  const fixed: Readonly<Scope> = Object.freeze({
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  });

  return {
    scope: fixed,
    where: (table, extra) => {
      const conditions = [
        eq(table.tenantId, fixed.tenantId),
        eq(table.organizationId, fixed.organizationId),
      ];
      if (extra !== undefined) conditions.push(extra);
      // and() only returns undefined for an empty list; here the list always has two entries.
      return and(...conditions) as SQL;
    },
    values: (row) => {
      const given = row as Partial<Scope>;
      // Never let a caller write into another scope. A different id is a bug (or an attack), so it throws
      // instead of being quietly overwritten; the same id is accepted so callers can pass full rows back in.
      if (given.tenantId !== undefined && given.tenantId !== fixed.tenantId) {
        throw new Error('values(): row.tenantId does not match the scope');
      }
      if (given.organizationId !== undefined && given.organizationId !== fixed.organizationId) {
        throw new Error('values(): row.organizationId does not match the scope');
      }
      return { ...row, ...fixed };
    },
  };
}
