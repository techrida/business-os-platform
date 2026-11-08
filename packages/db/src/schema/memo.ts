// Drizzle table for migration 0007_test_memo: the throwaway memo that exercises the kernel (P2 deletes it).
// Serves the audit NFR (the table is audited) and the money NFR (the NPR snapshot is stored on the row).
// The SQL in migrations/0007_test_memo.sql is the source of truth, including the assert_org_kind trigger that
// Drizzle cannot model; this file only types the queries, so keep the two in step.
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, organizations, tenants } from './platform.js';

/** Mirrors MEMO_STATUSES in @bos/contracts (the db package does not depend on contracts). */
export const MEMO_STATUSES = ['draft', 'submitted', 'approved', 'returned', 'rejected'] as const;

export const testMemos = appSchema.table(
  'test_memos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The owning (staff) org, never the customer's (ADR 0017). */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
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
    /** Record scope `own`. References app.users(id) in SQL; the foreign key lives only in the migration. */
    ownerUserId: uuid('owner_user_id').notNull(),
    /** Record scope `department`. */
    departmentId: uuid('department_id'),
    /** The counterparty a portal would show this memo to; the trigger checks it has kind `customer`. */
    customerOrganizationId: uuid('customer_organization_id').references(() => organizations.id),
    editorUserIds: uuid('editor_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('test_memos_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    index('test_memos_tenant_customer_org_idx').on(t.tenantId, t.customerOrganizationId),
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
  ],
);
