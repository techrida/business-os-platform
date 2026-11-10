// Platform tables (migration 0000). This file describes the tables to Drizzle so that queries are typed.
// The SQL that actually creates them is packages/db/migrations/0000_platform.sql, written by hand because
// it also holds things Drizzle cannot model (a trigger, the GRANT/REVOKE statements for the two roles).
// Keep the two in step: a change to a table is a new migration file, never an edit of 0000.
import { sql } from 'drizzle-orm';
import { check, index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Business data. Every table in here must carry tenant_id and organization_id (see check-tenancy.ts). */
export const appSchema = pgSchema('app');

/** Operational bookkeeping that is not business data (no tenancy columns needed). */
export const opsSchema = pgSchema('ops');

/**
 * One row per tenant (a company that runs Business OS). The only table in `app` allowed to lack
 * tenant_id / organization_id: it IS the tenant.
 */
export const tenants = appSchema.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The kinds of organization the API puts in its request context. Mirrors OrgKindSchema in @bos/contracts. */
export const ORG_KINDS = ['staff', 'customer', 'vendor'] as const;

/**
 * An organization inside a tenant: Techrida staff, a customer company or a vendor.
 *
 * `organizationId` always equals `id` (the row is its own organization). Storing it anyway keeps this table
 * shaped like every other business table, so scoped() and check-tenancy need no special case.
 * In SQL a BEFORE INSERT trigger fills it in when it is left out, and a CHECK keeps the two equal.
 */
export const organizations = appSchema.table(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: ORG_KINDS }).notNull(),
    name: text('name').notNull(),
    /** The organization id inside ZITADEL (the login service). The API maps a token's org claim to this. */
    zitadelOrgId: text('zitadel_org_id').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('organizations_kind_check', sql`${t.kind} in ('staff', 'customer', 'vendor')`),
    check('organizations_self_check', sql`${t.organizationId} = ${t.id}`),
    index('organizations_tenant_id_idx').on(t.tenantId),
  ],
);

/**
 * Written by the restore drill (infra/backup/restore-drill.sh) before each backup, then looked for in the
 * restored copy. bos_app may insert and read it, never change or delete a row.
 */
export const restoreCanary = opsSchema.table('restore_canary', {
  id: uuid('id').primaryKey().defaultRandom(),
  writtenAt: timestamp('written_at', { withTimezone: true }).notNull().defaultNow(),
});
