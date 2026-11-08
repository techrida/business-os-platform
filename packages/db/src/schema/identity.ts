// Drizzle tables for migration 0002_identity_authz: people (users, departments), what they may do
// (user_roles, role_permissions), the cache key for that (authz_versions) and the ZITADEL sync bookkeeping
// (ops.zitadel_events, ops.sync_cursors). Serves the authorization NFR: every decision rests on these rows.
// The SQL in migrations/0002_identity_authz.sql is the source of truth; this file only types the queries,
// so keep the two in step (a change is a new migration, never an edit of 0002).
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  check,
  index,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, opsSchema, organizations, tenants } from './platform.js';

/** Lifecycle of a user row. `invited` = created in ZITADEL, never logged in; `inactive` = may not act. */
export const USER_STATUSES = ['invited', 'active', 'inactive'] as const;

/** How far a role's permission reaches: the user's own records, their department, one customer org, everything. */
export const ROLE_PERMISSION_SCOPES = ['own', 'department', 'customer_org', 'all'] as const;

export const departments = appSchema.table(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    /** The department head. Departments and users point at each other, so both sides name AnyPgColumn. */
    headUserId: uuid('head_user_id').references((): AnyPgColumn => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('departments_tenant_org_idx').on(t.tenantId, t.organizationId)],
);

export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The user's own organization: a customer's user belongs to the customer organization. */
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** The ZITADEL `sub`. How a token finds its row. */
    zitadelUserId: text('zitadel_user_id').notNull().unique('users_zitadel_user_id_unique'),
    /** Nullable: the first-request upsert only knows what the token carries; the sync fills these in. */
    email: text('email'),
    displayName: text('display_name'),
    status: text('status', { enum: USER_STATUSES }).notNull(),
    departmentId: uuid('department_id').references((): AnyPgColumn => departments.id),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_status_check', sql`${t.status} in ('invited', 'active', 'inactive')`),
    index('users_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    index('users_tenant_org_department_idx').on(t.tenantId, t.organizationId, t.departmentId),
  ],
);

/** Mirror of the ZITADEL grants (ZITADEL is the truth). Primary key is the natural key, not id. */
export const userRoles = appSchema.table(
  'user_roles',
  {
    /** Not the primary key (that is user_id + role_key) but unique: the audit trigger identifies rows by id. */
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleKey: text('role_key').notNull(),
    source: text('source').notNull().default('zitadel'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'user_roles_user_id_role_key_pk', columns: [t.userId, t.roleKey] }),
    unique('user_roles_id_unique').on(t.id),
    index('user_roles_tenant_org_role_idx').on(t.tenantId, t.organizationId, t.roleKey),
  ],
);

export const rolePermissions = appSchema.table(
  'role_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    roleKey: text('role_key').notNull(),
    permission: text('permission').notNull(),
    scope: text('scope', { enum: ROLE_PERMISSION_SCOPES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('role_permissions_tenant_org_role_permission_unique').on(
      t.tenantId,
      t.organizationId,
      t.roleKey,
      t.permission,
    ),
    check(
      'role_permissions_scope_check',
      sql`${t.scope} in ('own', 'department', 'customer_org', 'all')`,
    ),
  ],
);

/** One row per organization: the cache key for the in-memory role cache. Not audited (check-audit allowlist). */
export const authzVersions = appSchema.table(
  'authz_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('authz_versions_tenant_org_unique').on(t.tenantId, t.organizationId)],
);

/** ZITADEL events already seen; the primary key makes a replay a no-op. No tenancy columns (ops). */
export const zitadelEvents = opsSchema.table(
  'zitadel_events',
  {
    instanceId: text('instance_id').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({
      name: 'zitadel_events_instance_id_aggregate_id_sequence_pk',
      columns: [t.instanceId, t.aggregateId, t.sequence],
    }),
    index('zitadel_events_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

/** Progress of the reconcile job, one row per named cursor. */
export const syncCursors = opsSchema.table('sync_cursors', {
  name: text('name').primaryKey(),
  cursor: text('cursor').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
