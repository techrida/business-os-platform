// Drizzle tables for migration 0002_identity_authz, reshaped by 0013_legal_entities (ADR 0027): people (users,
// departments, user_entities), what they may do (user_roles, role_permissions), the cache key for that
// (authz_versions) and the ZITADEL sync bookkeeping (ops.zitadel_events, ops.sync_cursors).
// Serves the authorization NFR: every decision rests on these rows.
// The SQL in migrations/0002_identity_authz.sql and 0013_legal_entities.sql is the source of truth; this file
// only types the queries, so keep the two in step (a change is a new migration, never an edit of an old one).
// users, user_roles, role_permissions and authz_versions are tenant-scoped: they have no organization_id.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, idpOrgs, opsSchema, organizations, tenants } from './platform.js';

/** Lifecycle of a user row. `invited` = created in ZITADEL, never logged in; `inactive` = may not act. */
export const USER_STATUSES = ['invited', 'active', 'inactive'] as const;

/**
 * Why a user is locked (migration 0125, F1-Q4): `failed_sign_ins` = ZITADEL's lockout policy locked them and the
 * lock-expiry job unlocks them at `locked_until`; `admin` = an admin locked them and only an admin unlocks.
 */
export const USER_LOCK_REASONS = ['failed_sign_ins', 'admin'] as const;

/** Lifecycle of a department row (migration 0086). Retired departments keep historical records. */
export const DEPARTMENT_STATUSES = ['active', 'retired'] as const;

/**
 * How far a role's permission reaches in code: the user's own records, their department, rows naming the caller's
 * party, everything. The database also accepts `assigned` (migrations 0082, read-only access to records the caller
 * was assigned work on); it joins this list, and `Scope`, when the access services honour it, because the API's
 * grant loader and `can()` are typed on these four.
 */
export const ROLE_PERMISSION_SCOPES = ['own', 'department', 'customer_org', 'all'] as const;

/** A department membership's rank (migration 0079). A head leads the department; a manager leads staff. */
export const MEMBERSHIP_LEVELS = ['staff', 'manager', 'head'] as const;

export const departments = appSchema.table(
  'departments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    name: text('name').notNull(),
    /** The department head. NULL until one is named; the composite FK below keeps the head in the same tenant. */
    headUserId: uuid('head_user_id'),
    /** Active or retired (migration 0086). Retired departments keep past records but take no new members. */
    status: text('status', { enum: DEPARTMENT_STATUSES }).notNull().default('active'),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    /** Optimistic concurrency guard incremented on rename, retire and restore (migration 0086). */
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('departments_tenant_org_idx').on(t.tenantId, t.organizationId),
    index('departments_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    uniqueIndex('departments_tenant_org_active_name_unique')
      .on(t.tenantId, t.organizationId, sql`lower(btrim(${t.name}))`)
      .where(sql`${t.status} = 'active'`),
    check('departments_status_check', sql`${t.status} in ('active', 'retired')`),
    check(
      'departments_retired_at_check',
      sql`(${t.status} = 'active' AND ${t.retiredAt} IS NULL) OR (${t.status} = 'retired' AND ${t.retiredAt} IS NOT NULL)`,
    ),
    check('departments_version_check', sql`${t.version} >= 1`),
    // Parent keys for composite FKs (user_entities, memos), ADR 0027 section 8.
    unique('departments_tenant_id_unique').on(t.tenantId, t.id),
    unique('departments_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // ADR 0027 section 8 (migration 0014_composite_keys). MATCH SIMPLE: head_user_id may be NULL.
    foreignKey({
      name: 'departments_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'departments_head_user_fk',
      columns: [t.tenantId, t.headUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/**
 * People. Tenant-scoped (ADR 0027 section 3): no organization_id and no department (the department moved to
 * user_entities). A staff user belongs to the tenant through the staff IdP org; a portal user belongs to a party
 * through its IdP org (the party comes from idp_orgs.party_id and is not copied here).
 */
export const users = appSchema.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The ZITADEL org the user logs in through. The tenant follows from it (R26 checks the two match). */
    idpOrgId: uuid('idp_org_id').notNull(),
    /** The ZITADEL `sub`. How a token finds its row. */
    zitadelUserId: text('zitadel_user_id').notNull().unique('users_zitadel_user_id_unique'),
    /** Nullable: the first-request upsert only knows what the token carries; the sync fills these in. */
    email: text('email'),
    displayName: text('display_name'),
    status: text('status', { enum: USER_STATUSES }).notNull(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    /**
     * The avatar image, an `app.documents.id` (migration 0053). No foreign key: documents are owned per tenant
     * and entity, and a user works in several entities. NULL shows the initials avatar.
     */
    avatarDocumentId: uuid('avatar_document_id'),
    /** Why the user is locked; NULL = not locked (migration 0125). A locked user's status is 'inactive'. */
    lockReason: text('lock_reason', { enum: USER_LOCK_REASONS }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** When the lock-expiry job unlocks a `failed_sign_ins` lock; NULL for an admin lock. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /**
     * Set by a failed or ambiguous write to ZITADEL (migration 0189). A flagged person is never 'active' (a trigger,
     * 0190); sync never clears it. An admin resolves it after reading ZITADEL again.
     */
    identityReviewRequired: boolean('identity_review_required').notNull().default(false),
    identityReviewAt: timestamp('identity_review_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_status_check', sql`${t.status} in ('invited', 'active', 'inactive')`),
    check('users_lock_reason_check', sql`${t.lockReason} IN ('failed_sign_ins', 'admin')`),
    check(
      'users_lock_shape_check',
      sql`(${t.lockReason} IS NULL AND ${t.lockedAt} IS NULL AND ${t.lockedUntil} IS NULL)
        OR (${t.lockReason} = 'admin' AND ${t.lockedAt} IS NOT NULL AND ${t.lockedUntil} IS NULL)
        OR (${t.lockReason} = 'failed_sign_ins' AND ${t.lockedAt} IS NOT NULL AND ${t.lockedUntil} IS NOT NULL)`,
    ),
    index('users_identity_review_idx')
      .on(t.tenantId)
      .where(sql`${t.identityReviewRequired}`),
    index('users_lock_expiry_idx')
      .on(t.lockedUntil)
      .where(sql`${t.lockReason} = 'failed_sign_ins'`),
    index('users_display_name_trgm_idx').using('gin', t.displayName.op('gin_trgm_ops')),
    index('users_email_trgm_idx').using('gin', t.email.op('gin_trgm_ops')),
    index('users_tenant_status_idx').on(t.tenantId, t.status),
    index('users_tenant_idp_org_idx').on(t.tenantId, t.idpOrgId),
    // Parent key for composite FKs (tenant_id, user_id), ADR 0027 section 8.
    unique('users_tenant_id_unique').on(t.tenantId, t.id),
    // The IdP org must belong to the same tenant (ADR 0027 section 8, migration 0014_composite_keys).
    foreignKey({
      name: 'users_idp_org_fk',
      columns: [t.tenantId, t.idpOrgId],
      foreignColumns: [idpOrgs.tenantId, idpOrgs.id],
    }),
  ],
);

/** Mirror of the ZITADEL grants (ZITADEL is the truth). Tenant-scoped. Primary key is the natural key, not id. */
export const userRoles = appSchema.table(
  'user_roles',
  {
    /** Not the primary key (that is tenant_id + user_id + role_key) but unique: the audit trigger identifies rows by id. */
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id').notNull(),
    roleKey: text('role_key').notNull(),
    source: text('source').notNull().default('zitadel'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'user_roles_tenant_id_user_id_role_key_pk',
      columns: [t.tenantId, t.userId, t.roleKey],
    }),
    unique('user_roles_id_unique').on(t.id),
    // The user must belong to the same tenant (ADR 0027 section 8, migration 0014_composite_keys).
    foreignKey({
      name: 'user_roles_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('user_roles_tenant_role_idx').on(t.tenantId, t.roleKey),
  ],
);

/** What a role may do. Company policy, so tenant-scoped (ADR 0027 section 7); membership narrows it per entity. */
export const rolePermissions = appSchema.table(
  'role_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roleKey: text('role_key').notNull(),
    permission: text('permission').notNull(),
    scope: text('scope', { enum: ROLE_PERMISSION_SCOPES }).notNull(),
    /** True on a row the seed wrote from the code defaults; false on a row a Founder made (migration 0081). */
    seeded: boolean('seeded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('role_permissions_tenant_role_permission_unique').on(
      t.tenantId,
      t.roleKey,
      t.permission,
    ),
    check(
      'role_permissions_scope_check',
      sql`${t.scope} in ('own', 'department', 'customer_org', 'all', 'assigned')`,
    ),
  ],
);

/**
 * The grant a role gives a member of `minLevel` or above, widening the role's base grant (migration 0082): the
 * most senior row at or below the member's level wins. Tenant-scoped, audited, `seeded` as in role_permissions.
 */
export const rolePermissionLevels = appSchema.table(
  'role_permission_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roleKey: text('role_key').notNull(),
    permission: text('permission').notNull(),
    minLevel: text('min_level', { enum: ['manager', 'head'] as const }).notNull(),
    scope: text('scope', { enum: ROLE_PERMISSION_SCOPES }).notNull(),
    seeded: boolean('seeded').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('role_permission_levels_tenant_role_permission_level_unique').on(
      t.tenantId,
      t.roleKey,
      t.permission,
      t.minLevel,
    ),
    check('role_permission_levels_min_level_check', sql`${t.minLevel} in ('manager', 'head')`),
    check(
      'role_permission_levels_scope_check',
      sql`${t.scope} in ('own', 'department', 'customer_org', 'all', 'assigned')`,
    ),
  ],
);

/** One row per tenant: the cache key for the in-memory role cache. Not audited (check-audit allowlist). */
export const authzVersions = appSchema.table(
  'authz_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('authz_versions_tenant_unique').on(t.tenantId)],
);

/**
 * Which legal entities a staff user may act for (ADR 0027 section 3). Entity-owned: the department lives here
 * because a department belongs to one entity. Effective roles in entity E = the token's roles intersected with
 * `roleKeys` of the membership for E (NULL means all token roles). BOS can only narrow, never widen.
 */
export const userEntities = appSchema.table(
  'user_entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** The entity used when a request names none. At most one per user. */
    isDefault: boolean('is_default').notNull().default(false),
    /** The roles this membership allows; NULL = every role in the token. */
    roleKeys: text('role_keys').array(),
    departmentId: uuid('department_id'),
    /** When the member joined the current department (migration 0086). NULL when unassigned. */
    departmentSince: timestamp('department_since', { withTimezone: true }),
    /** Rank in the department (migration 0079); departments.head_user_id follows level `head`. */
    level: text('level', { enum: MEMBERSHIP_LEVELS }).notNull().default('staff'),
    jobTitle: text('job_title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_entities_tenant_org_user_unique').on(t.tenantId, t.organizationId, t.userId),
    // PostgreSQL has no partial unique constraint, so this is a unique index: one default entity per user.
    uniqueIndex('user_entities_tenant_user_default_unique')
      .on(t.tenantId, t.userId)
      .where(sql`${t.isDefault}`),
    foreignKey({
      name: 'user_entities_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'user_entities_tenant_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    // MATCH SIMPLE: not checked while department_id is NULL.
    foreignKey({
      name: 'user_entities_tenant_org_department_fk',
      columns: [t.tenantId, t.organizationId, t.departmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    index('user_entities_tenant_user_idx').on(t.tenantId, t.userId),
    check('user_entities_level_check', sql`${t.level} in ('staff', 'manager', 'head')`),
    check(
      'user_entities_head_department_check',
      sql`${t.level} <> 'head' OR ${t.departmentId} IS NOT NULL`,
    ),
    index('user_entities_tenant_org_department_level_idx').on(
      t.tenantId,
      t.organizationId,
      t.departmentId,
      t.level,
    ),
  ],
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
