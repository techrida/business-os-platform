// Drizzle table for migration 0007_test_memo: the throwaway memo that exercises the kernel (P2 deletes it).
// Serves the audit NFR (the table is audited) and the money NFR (the NPR snapshot is stored on the row).
// The SQL in migrations/0007_test_memo.sql and 0013_legal_entities.sql is the source of truth (0013 drops the
// assert_org_kind trigger: the kind is now an FK to parties); this file only types the queries, so keep them in step.
// 0039_discard_memo_drafts adds the soft discard (discarded_at, discarded_by_user_id) and its guard trigger.
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { departments, users } from './identity.js';
import { appSchema, organizations, parties, tenants } from './platform.js';

/** Mirrors MEMO_STATUSES in @bos/contracts (the db package does not depend on contracts). */
export const MEMO_STATUSES = ['draft', 'submitted', 'approved', 'returned', 'rejected'] as const;

type MemoPerson = {
  userId: string;
  name: string;
  jobTitle: string | null;
  department: string | null;
};

export const testMemos = appSchema.table(
  'test_memos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The owning legal entity, never the customer (ADR 0027). */
    organizationId: uuid('organization_id').notNull(),
    template: jsonb('template').$type<{
      organizationId: string;
      organizationName: string;
      departmentId: string;
      departmentName: string;
      date: string;
      closing: string;
      preparedBy: MemoPerson;
      recommenders: MemoPerson[];
      approvedBy: MemoPerson;
    }>(),
    number: text('number').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountNpr: numeric('amount_npr', { precision: 18, scale: 2 }).notNull(),
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }).notNull(),
    fxSource: text('fx_source').notNull(),
    /** `YYYY-MM-DD`, kept as a string so no time zone can shift the day. */
    fxDate: date('fx_date', { mode: 'string' }).notNull(),
    status: text('status', { enum: MEMO_STATUSES }).notNull().default('draft'),
    /** Record scope `own`. Composite FK test_memos_owner_user_fk (tenant_id, owner_user_id) -> users, below. */
    ownerUserId: uuid('owner_user_id').notNull(),
    /** Record scope `department`. */
    departmentId: uuid('department_id'),
    /** The customer party a portal would show this memo to (ADR 0027 section 5). Nullable. */
    customerPartyId: uuid('customer_party_id'),
    /**
     * Always 'customer' (a stored generated column), so the composite FK below makes the database check the
     * party's kind. This replaces the assert_org_kind trigger. Drizzle models it with generatedAlwaysAs; the
     * column is left out of inserts. PostgreSQL allows the FK only with the default NO ACTION (never CASCADE
     * or SET NULL on a generated column), and the type must be text to match parties.kind.
     */
    customerPartyKind: text('customer_party_kind').generatedAlwaysAs(sql`'customer'`),
    editorUserIds: uuid('editor_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    version: integer('version').notNull().default(1),
    /**
     * Soft discard (0039): set once by the creator on a draft or returned memo, never cleared. The memo keeps its
     * number, status, audit trail and attachments; every read and write of the memo skips rows where this is set.
     */
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    /** Always the owner (test_memos_discarded_by_owner_check). Composite FK test_memos_discarded_by_fk below. */
    discardedByUserId: uuid('discarded_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('test_memos_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    // ADR 0027 section 8 (migration 0014_composite_keys). The department FK is MATCH SIMPLE: not checked while NULL.
    foreignKey({
      name: 'test_memos_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'test_memos_department_fk',
      columns: [t.tenantId, t.organizationId, t.departmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    foreignKey({
      name: 'test_memos_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    // Created by 0007 as test_memos_tenant_customer_org_idx; it follows the renamed column, so 0013 renames it too.
    // 0039. MATCH SIMPLE: not checked while discarded_by_user_id is NULL.
    foreignKey({
      name: 'test_memos_discarded_by_fk',
      columns: [t.tenantId, t.discardedByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('test_memos_tenant_customer_party_idx').on(t.tenantId, t.customerPartyId),
    // MATCH SIMPLE: not checked while customer_party_id is NULL.
    foreignKey({
      name: 'test_memos_customer_party_fk',
      columns: [t.tenantId, t.customerPartyId, t.customerPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    index('test_memos_tenant_org_owner_idx').on(t.tenantId, t.organizationId, t.ownerUserId),
    check(
      'test_memos_status_check',
      sql`${t.status} in ('draft', 'submitted', 'approved', 'returned', 'rejected')`,
    ),
    check('test_memos_amount_check', sql`${t.amount} >= 0`),
    check('test_memos_amount_npr_check', sql`${t.amountNpr} >= 0`),
    check('test_memos_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('test_memos_fx_rate_check', sql`${t.fxRate} > 0`),
    check('test_memos_version_check', sql`${t.version} >= 1`),
    check(
      'test_memos_discarded_pair_check',
      sql`(${t.discardedAt} IS NULL) = (${t.discardedByUserId} IS NULL)`,
    ),
    check(
      'test_memos_discarded_status_check',
      sql`${t.discardedAt} IS NULL OR ${t.status} in ('draft', 'returned')`,
    ),
    check(
      'test_memos_discarded_by_owner_check',
      sql`${t.discardedByUserId} IS NULL OR ${t.discardedByUserId} = ${t.ownerUserId}`,
    ),
  ],
);
