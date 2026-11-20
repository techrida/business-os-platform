// Drizzle table for migration 0113_payment_promises: a customer's promise to pay an issued invoice by a date
// (F1-Q33). The SQL in migrations/0113_payment_promises.sql is the source of truth; this file only types the
// queries, so keep the two in step (payment-promises-schema.test.ts compares them). Entity-owned.
// Not modelled here: the partial indexes' WHERE clauses are, but drizzle does not check them against the SQL.
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { invoices } from './invoicing.js';
import { appSchema, organizations, tenants } from './platform.js';

/** open until the payment-promise job settles it: `missed` (date passed, invoice still open) or `kept`. */
export const PAYMENT_PROMISE_STATUSES = ['open', 'missed', 'kept'] as const;

export const paymentPromises = appSchema.table(
  'payment_promises',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    invoiceId: uuid('invoice_id').notNull(),
    /** The calendar day (Asia/Kathmandu) the customer promised to pay by. */
    promisedDate: date('promised_date', { mode: 'string' }).notNull(),
    note: text('note'),
    status: text('status', { enum: PAYMENT_PROMISE_STATUSES }).notNull().default('open'),
    recordedByUserId: uuid('recorded_by_user_id').notNull(),
    /** Set with collectionActivityId when the job marks the promise missed. */
    missedAt: timestamp('missed_at', { withTimezone: true }),
    /** The collection call (app.activities) the job planned. No FK: see the migration's header. */
    collectionActivityId: uuid('collection_activity_id'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('payment_promises_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'payment_promises_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'payment_promises_invoice_fk',
      columns: [t.tenantId, t.organizationId, t.invoiceId],
      foreignColumns: [invoices.tenantId, invoices.organizationId, invoices.id],
    }),
    foreignKey({
      name: 'payment_promises_recorded_by_fk',
      columns: [t.tenantId, t.recordedByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('payment_promises_status_check', sql`${t.status} in ('open', 'missed', 'kept')`),
    check('payment_promises_note_check', sql`${t.note} IS NULL OR length(${t.note}) <= 1000`),
    check(
      'payment_promises_missed_check',
      sql`(${t.status} = 'missed') = (${t.missedAt} IS NOT NULL AND ${t.collectionActivityId} IS NOT NULL)`,
    ),
    check('payment_promises_version_check', sql`${t.version} >= 1`),
    uniqueIndex('payment_promises_one_open_idx')
      .on(t.tenantId, t.organizationId, t.invoiceId)
      .where(sql`${t.status} = 'open'`),
    index('payment_promises_tenant_org_invoice_idx').on(t.tenantId, t.organizationId, t.invoiceId),
    index('payment_promises_open_due_idx')
      .on(t.promisedDate)
      .where(sql`${t.status} = 'open'`),
  ],
);
