// Which tables reach further than an `ownerUserId` column, and how. Serves D50, D55-3 and D55-5: `own` on a lead
// also covers the leads the caller entered, and `own` on a lead, opportunity or quotation covers the records the
// caller holds a follow-up on, read only. Plus the tables whose owner column has another name (an invoice's
// `created_by`, a vendor bill's `entered_by`), so `own` reaches them at all.
//
// One description per table feeds both halves of authz: `scopeWhereFor()` (the list query) reads the columns, and
// `can()` (the record check) reads the reader ids that `loadReaders()` fetched from the same columns. A service
// that already filters with `scopeWhereFor(p, table, permission)` honours the reach with no change of its own.
import type { Permission } from '@bos/contracts';
import {
  activities,
  invoices,
  leads,
  opportunities,
  purchaseRequests,
  quotations,
  salesOrders,
  type ScopedTable,
  vendorBills,
} from '@bos/db';
import { and, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import type { ScopableTable } from './principal';

/** Rows that hand a record to a user: `activities` in the app, a fixture table in tests. */
export type AssignmentTable = ScopedTable & {
  assigneeUserId: AnyPgColumn;
  cancelledAt: AnyPgColumn;
};

/** How one table is reached. Every column is named here, so nothing falls back to a guessed property. */
export interface RecordReach {
  /** The record's id, which the assignment rows point at. */
  id: AnyPgColumn;
  /** Whose record it is: `own` matches it. Absent means `own` reaches no row through an owner. */
  owner?: AnyPgColumn;
  /** The record's department: `department` matches it. Absent means `department` reaches what `own` does. */
  department?: AnyPgColumn;
  /**
   * The read permission whose `own` (and so `department`) reach also covers `creator` and the assignees, and the
   * only permission `assigned` works on. Writes never get this reach (D55-3): they stay with the owner.
   */
  readPermission?: Permission;
  /** Who entered the record (leads only, D50 `created`). */
  creator?: AnyPgColumn;
  /** The assignment rows naming this table's records in `subject`. */
  assignment?: { table: AssignmentTable; subject: AnyPgColumn };
  /**
   * A second owner, held on a parent row (U20a2-Q1): `own` (and so `department`) also matches the records whose
   * `key` names a `parent` row the caller owns. Like `owner`, it counts for every permission on the table.
   */
  ownerVia?: OwnerVia;
}

/** "The owner of the parent row this record points at": see `RecordReach.ownerVia`. */
export interface OwnerVia {
  parent: ScopableTable;
  /** This table's column that holds the parent's id. */
  key: AnyPgColumn;
  parentId: AnyPgColumn;
  parentOwner: AnyPgColumn;
}

/** What `can()` needs to know about a read permission, without a table at hand. */
export interface ReadReach {
  creator: boolean;
  assignee: boolean;
}

const REACH = new Map<object, RecordReach>();
const READ_REACH = new Map<Permission, ReadReach>();

/**
 * Registers how `table` is reached. Called once per table below; a test registers a fixture table the same way so
 * it exercises the real `scopeWhereFor()` and `can()` without the app schema. One read permission belongs to one
 * table, so the record check (which knows only the permission) and the list (which knows the table) cannot read
 * different reach for it.
 */
export function defineRecordReach(table: ScopableTable, reach: RecordReach): void {
  REACH.set(table, reach);
  if (reach.readPermission !== undefined) {
    READ_REACH.set(reach.readPermission, {
      creator: reach.creator !== undefined,
      assignee: reach.assignment !== undefined,
    });
  }
}

/** The description of `table`, or undefined for a table that relies on its `ownerUserId`/`departmentId`. */
export function recordReachOf(table: ScopableTable): RecordReach | undefined {
  return REACH.get(table);
}

/** Whether `own` on `permission` reaches creators and assignees, and whether `assigned` means anything for it. */
export function readReachOf(permission: Permission): ReadReach | undefined {
  return READ_REACH.get(permission);
}

/**
 * "`userId` holds a non-cancelled assignment on this row", correlated to the outer query's row of `reach`'s table.
 * Tenant and entity are matched too: an activity of another entity never hands over a record.
 */
export function assignedToSql(table: ScopableTable, reach: RecordReach, userId: string): SQL {
  if (reach.assignment === undefined) return sql`false`;
  const { table: a, subject } = reach.assignment;
  return sql`exists (
    select 1 from ${a}
    where ${a.tenantId} = ${table.tenantId}
      and ${a.organizationId} = ${table.organizationId}
      and ${subject} = ${reach.id}
      and ${a.assigneeUserId} = ${userId}
      and ${a.cancelledAt} is null
  )`;
}

/**
 * "`userId` owns the parent row this row points at", correlated to the outer query's row of `table`. Tenant and
 * entity are matched too, so a parent of another entity never hands a record over.
 */
export function ownedViaSql(table: ScopableTable, via: OwnerVia, userId: string): SQL {
  const { parent } = via;
  return sql`exists (
    select 1 from ${parent}
    where ${parent.tenantId} = ${table.tenantId}
      and ${parent.organizationId} = ${table.organizationId}
      and ${via.parentId} = ${via.key}
      and ${via.parentOwner} = ${userId}
  )`;
}

/** The people a record check must know about to agree with the list: see `ResourceRef.creatorUserId`. */
export interface RecordReaders {
  creatorUserId: string | null;
  assigneeUserIds: readonly string[];
}

const NO_READERS: RecordReaders = Object.freeze({ creatorUserId: null, assigneeUserIds: [] });

/**
 * The creator and assignees of each record in `ids`, for the `ResourceRef` a service passes to `can()` on a read.
 * Every id is in the answer (with no readers when it has none or is not in this scope). Two queries, whatever the
 * number of ids, so a list page can fill its refs at once. Throws for a table with no record reach: a caller that
 * thinks it needs readers for such a table has the wrong table.
 */
export async function loadReaders(
  q: Db | DbTransaction,
  scope: TxScope,
  table: ScopableTable,
  ids: readonly string[],
): Promise<ReadonlyMap<string, RecordReaders>> {
  const reach = recordReachOf(table);
  if (reach === undefined || reach.readPermission === undefined) {
    throw new Error('loadReaders(): this table has no read reach (see record-reach.ts)');
  }
  const out = new Map<string, { creatorUserId: string | null; assigneeUserIds: string[] }>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { creatorUserId: null, assigneeUserIds: [] });

  if (reach.creator !== undefined) {
    const rows = await q
      .select({ id: reach.id, creatorUserId: reach.creator })
      .from(table)
      .where(
        and(
          eq(table.tenantId, scope.tenantId),
          eq(table.organizationId, scope.organizationId),
          inArray(reach.id, [...ids]),
        ),
      );
    for (const row of rows) {
      const entry = out.get(String(row.id));
      if (entry !== undefined) entry.creatorUserId = (row.creatorUserId as string | null) ?? null;
    }
  }

  if (reach.assignment !== undefined) {
    const { table: a, subject } = reach.assignment;
    const rows = await q
      .select({ subjectId: subject, userId: a.assigneeUserId })
      .from(a)
      .where(
        and(
          eq(a.tenantId, scope.tenantId),
          eq(a.organizationId, scope.organizationId),
          inArray(subject, [...ids]),
          isNotNull(a.assigneeUserId),
          isNull(a.cancelledAt),
        ),
      );
    for (const row of rows) {
      const entry = out.get(String(row.subjectId));
      const userId = row.userId as string | null;
      if (entry !== undefined && userId !== null && !entry.assigneeUserIds.includes(userId)) {
        entry.assigneeUserIds.push(userId);
      }
    }
  }
  return out;
}

/** The readers of one record, for a service that checks a single row. */
export async function loadRecordReaders(
  q: Db | DbTransaction,
  scope: TxScope,
  table: ScopableTable,
  id: string,
): Promise<RecordReaders> {
  return (await loadReaders(q, scope, table, [id])).get(id) ?? NO_READERS;
}

// --- The app's tables -------------------------------------------------------------------------------------------

defineRecordReach(leads, {
  id: leads.id,
  owner: leads.ownerUserId,
  department: leads.departmentId,
  readPermission: 'crm.lead.read',
  creator: leads.createdByUserId,
  assignment: { table: activities, subject: activities.leadId },
});

defineRecordReach(opportunities, {
  id: opportunities.id,
  owner: opportunities.ownerUserId,
  department: opportunities.departmentId,
  readPermission: 'crm.opportunity.read',
  assignment: { table: activities, subject: activities.opportunityId },
});

defineRecordReach(quotations, {
  id: quotations.id,
  owner: quotations.ownerUserId,
  // Stamped from the opportunity by migration 0088 (K4), so a department grant reaches quotations too.
  department: quotations.departmentId,
  readPermission: 'quotation.read',
  assignment: { table: activities, subject: activities.quotationId },
});

// No owner column of that name: whoever entered the document owns it for `own`. None of them has a department,
// so `department` reaches the same rows as `own` (spec review R2).
defineRecordReach(invoices, { id: invoices.id, owner: invoices.createdBy });
defineRecordReach(vendorBills, { id: vendorBills.id, owner: vendorBills.enteredBy });
// U20a2-Q1: an order is also its source quotation's owner's (SalesOrdersService's own rule, "records they created
// or own"), so the list and the service read the same reach. A record check passes that owner as a second ref.
defineRecordReach(salesOrders, {
  id: salesOrders.id,
  owner: salesOrders.createdBy,
  ownerVia: {
    parent: quotations,
    key: salesOrders.quotationId,
    parentId: quotations.id,
    parentOwner: quotations.ownerUserId,
  },
});

defineRecordReach(purchaseRequests, {
  id: purchaseRequests.id,
  owner: purchaseRequests.requesterUserId,
  department: purchaseRequests.departmentId,
});
