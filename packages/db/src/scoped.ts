import { and, eq, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';

/**
 * Who is asking. Both ids are required: a tenant alone is not enough to read an entity's rows. `organizationId`
 * is the acting legal entity (ADR 0027 §4), for staff and portal users alike.
 */
export interface Scope {
  tenantId: string;
  organizationId: string;
}

/** Any Drizzle table that has the two tenancy columns, under these property names. */
export type ScopedTable = PgTable & { tenantId: AnyPgColumn; organizationId: AnyPgColumn };

/** Which counterparty a portal user is: the table column is `customer_party_id` or `vendor_party_id`. */
export type CounterpartyKind = 'customer' | 'vendor';

const COUNTERPARTY_PROPERTY = {
  customer: 'customerPartyId',
  vendor: 'vendorPartyId',
} as const satisfies Record<CounterpartyKind, string>;

/** An entity-owned table with the counterparty column for `K` (ADR 0027 §5). */
export type CounterpartyTable<K extends CounterpartyKind> = ScopedTable &
  Record<(typeof COUNTERPARTY_PROPERTY)[K], AnyPgColumn>;

export interface Scoped {
  readonly scope: Readonly<Scope>;
  /** `tenant_id = $1 AND organization_id = $2`, and `extra` too when given. Pass the result to .where(). */
  where: (table: ScopedTable, extra?: SQL) => SQL;
  /**
   * The portal read filter (ADR 0027 §5): `tenant_id = $1 AND organization_id = $2 AND customer_party_id = $3`
   * (or `vendor_party_id`), and `extra` too when given. `$2` is the acting entity (this scope's
   * organizationId) and `$3` is the principal's party (`partyId`), so a portal user sees only the rows of the
   * entity they are acting with that name their own party.
   */
  forCounterparty: <K extends CounterpartyKind>(
    table: CounterpartyTable<K>,
    kind: K,
    partyId: string,
    extra?: SQL,
  ) => SQL;
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
 * It takes the ids explicitly and infers nothing. Callers pass the ids from the request context: the tenant,
 * the acting entity and, for portal reads, the principal's party (ADR 0027 §4 and §5).
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
    forCounterparty: (table, kind, partyId, extra) => {
      if (partyId === '') {
        // Same reason as the empty-id check above.
        throw new Error('forCounterparty() needs a non-empty partyId');
      }
      // A JS caller (or a cast) could pass a table without the column. eq(undefined, ...) would build broken
      // SQL at best, so fail loudly instead.
      const column = (table as Record<string, AnyPgColumn | undefined>)[
        COUNTERPARTY_PROPERTY[kind]
      ];
      if (column === undefined) {
        throw new Error(
          `forCounterparty(): the table has no ${COUNTERPARTY_PROPERTY[kind]} column`,
        );
      }
      const conditions = [
        eq(table.tenantId, fixed.tenantId),
        eq(table.organizationId, fixed.organizationId),
        eq(column, partyId),
      ];
      if (extra !== undefined) conditions.push(extra);
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
