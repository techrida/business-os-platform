// What services call to enforce authz inside a handler: `assert()` for one record, `scopeWhere()` to
// filter a list query to the same rows `can()` would allow, and `invalidate()` after a role change.
// Serves the NFR "authorization is deny-by-default" (P1 plan §1, k-authz; §6.2): a list query and a
// record check give the same answer, so a user cannot see a row in a list that they could not open.
import type { Permission } from '@bos/contracts';
import { authzVersions, type Scoped, scoped } from '@bos/db';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { eq, or, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { DB, type Db } from '../db/db.module';
import { systemActor, withTx } from '../db/tx';
import { can } from './can';
import { type Principal, type ResourceRef, type ScopableTable, principal } from './principal';
import { type RecordReach, assignedToSql, recordReachOf } from './record-reach';
import { RoleCache } from './role-cache';

// The @bos/db index exports `Scoped` but not its counterparty helper types, so derive them here.
type CounterpartyKind = Parameters<Scoped['forCounterparty']>[1];
type AnyCounterpartyTable = Parameters<Scoped['forCounterparty']>[0];

/** Matches no row. Every "cannot reach" case returns this, so the default is an empty list. */
const NOTHING: SQL = sql`false`;

/** The party column of `table` for the principal's org kind; staff have none (see can.ts). */
function counterpartyColumn(
  p: Principal,
  table: ScopableTable,
): { kind: CounterpartyKind; column: AnyPgColumn } | undefined {
  if (p.orgKind === 'customer' && table.customerPartyId !== undefined) {
    return { kind: 'customer', column: table.customerPartyId };
  }
  if (p.orgKind === 'vendor' && table.vendorPartyId !== undefined) {
    return { kind: 'vendor', column: table.vendorPartyId };
  }
  return undefined;
}

/**
 * The portal rule (ADR 0017, revised by ADR 0027 §5): rows of the acting entity whose party column
 * equals `p.partyId`. Staff, a table without the column and a principal with no party match nothing.
 */
function portalRows(p: Principal, table: ScopableTable, s: Scoped): SQL {
  const counterparty = counterpartyColumn(p, table);
  if (counterparty === undefined || p.partyId === null || p.partyId === '') return NOTHING;
  // Safe cast: counterpartyColumn() returned only because the table has this kind's column.
  return s.forCounterparty(table as unknown as AnyCounterpartyTable, counterparty.kind, p.partyId);
}

/** The columns a scope compares, from record-reach.ts when the table is described there. */
interface ScopeColumns {
  owner: AnyPgColumn | undefined;
  department: AnyPgColumn | undefined;
  /** The table's reach when `action` is its read permission; undefined for every other action. */
  readReach: RecordReach | undefined;
}

function columnsOf(table: ScopableTable, action: Permission): ScopeColumns {
  const reach = recordReachOf(table);
  if (reach === undefined) {
    return { owner: table.ownerUserId, department: table.departmentId, readReach: undefined };
  }
  return {
    owner: reach.owner,
    department: reach.department,
    readReach: reach.readPermission === action ? reach : undefined,
  };
}

/**
 * `p`'s own rows, the SQL of `isMine()` in can.ts: the owner column, plus on the table's read permission the
 * creator and the assignees. Undefined when the table has none of them, which matches no row.
 */
function mineCondition(p: Principal, table: ScopableTable, c: ScopeColumns): SQL | undefined {
  const parts: SQL[] = [];
  if (c.owner !== undefined) parts.push(eq(c.owner, p.userId));
  const reach = c.readReach;
  if (reach !== undefined) {
    if (reach.creator !== undefined) parts.push(eq(reach.creator, p.userId));
    if (reach.assignment !== undefined) parts.push(assignedToSql(table, reach, p.userId));
  }
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : or(...parts);
}

/**
 * The SQL twin of `can(p, action, r)` for every row `r` of `table`: a row matches exactly when
 * `can()` would allow it. Each branch mirrors `inScope()` in can.ts; a column the table lacks is
 * treated like a missing `ResourceRef` field, which never matches. The columns come from
 * record-reach.ts when the table is described there, else from `ownerUserId` and `departmentId`.
 *
 * Separation of duties is not expressed here (it depends on who prepared each record, not on a
 * column), so an SoD action still needs `assert()` on the chosen record.
 */
export function scopeWhereFor(p: Principal, table: ScopableTable, action: Permission): SQL {
  if (p.status !== 'active') return NOTHING;
  const scope = p.grants.get(action);
  if (scope === undefined) return NOTHING;

  const s = scoped({ tenantId: p.tenantId, organizationId: p.organizationId });
  const c = columnsOf(table, action);
  switch (scope) {
    case 'assigned': {
      // Read only: on a write, or on a table no assignment hands over, `can()` refuses it too.
      const reach = c.readReach;
      if (reach?.assignment === undefined) return NOTHING;
      return s.where(table, assignedToSql(table, reach, p.userId));
    }
    case 'own': {
      const mine = mineCondition(p, table, c);
      return mine === undefined ? NOTHING : s.where(table, mine);
    }
    case 'department': {
      // Cumulative: my own rows anywhere, and every row of my department. No department (mine or the
      // table's) leaves just the own rows; NULL = NULL would not match anyway, but be explicit.
      const mine = mineCondition(p, table, c);
      const parts: SQL[] = mine === undefined ? [] : [mine];
      if (p.departmentId !== null && c.department !== undefined) {
        parts.push(eq(c.department, p.departmentId));
      }
      if (parts.length === 0) return NOTHING;
      return s.where(table, parts.length === 1 ? parts[0] : or(...parts));
    }
    case 'customer_org':
      return portalRows(p, table, s);
    case 'all':
      // Staff: every row of the acting entity. A portal caller: the `customer_org` rows, because
      // its `organizationId` is the acting entity and would otherwise reach every staff document.
      if (p.orgKind === 'staff') return s.where(table);
      return portalRows(p, table, s);
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
   * Bumps the tenant's `authz_versions` row, so every api instance reloads the tenant's role rows
   * within 5 s (R11), and this instance at once, for every entity of the tenant (ADR 0027 §7). Call
   * it after the `role_permissions` change has committed: a reload between this bump and that commit
   * would cache the old rows under the new version. `organizationId` is the acting entity: the
   * write is audited under it (a tenant-scoped row has no entity of its own).
   */
  async invalidate(tenantId: string, organizationId: string): Promise<void> {
    await withTx(
      this.db,
      { tenantId, organizationId },
      systemActor('authz.invalidate'),
      async (tx) => {
        await tx
          .insert(authzVersions)
          .values({ tenantId, version: 1 })
          .onConflictDoUpdate({
            target: [authzVersions.tenantId],
            set: { version: sql`${authzVersions.version} + 1`, updatedAt: sql`now()` },
          });
      },
    );
    this.roleCache.forget(tenantId, organizationId);
  }
}
