// Drizzle table definitions for Access Settings (U20b): migrations 0084_access_revisions and
// 0085_assignment_rules. The SQL migrations are the source of truth; keep this file in step with them.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { departments, users } from './identity.js';
import { appSchema, organizations, tenants } from './platform.js';

export const ACCESS_ASSIGNMENT_AREAS = ['leads', 'opportunities'] as const;
export const ACCESS_STAFF_ASSIGNMENT_RULES = [
  'self_and_peers',
  'self_only',
  'any_at_or_below',
] as const;
export const ACCESS_MANAGER_ASSIGNMENT_RULES = ['any_at_or_below', 'self_and_staff'] as const;

/**
 * One row per tenant: concurrency revision for Access Settings saves, last-changed metadata, and whether
 * default rows have been materialized into app.role_permission_levels. Tenant-scoped (no organization_id).
 */
export const accessRevisions = appSchema.table(
  'access_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    levelRulesMaterialized: boolean('level_rules_materialized').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid('updated_by_user_id'),
  },
  (t) => [
    unique('access_revisions_tenant_unique').on(t.tenantId),
    foreignKey({
      name: 'access_revisions_updated_by_user_fk',
      columns: [t.tenantId, t.updatedByUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('access_revisions_revision_nonneg_check', sql`${t.revision} >= 0`),
  ],
);

/** Entity-owned "Who can assign" rules per area (leads, opportunities). */
export const accessAssignmentRules = appSchema.table(
  'access_assignment_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    area: text('area', { enum: ACCESS_ASSIGNMENT_AREAS }).notNull(),
    staffRule: text('staff_rule', { enum: ACCESS_STAFF_ASSIGNMENT_RULES })
      .notNull()
      .default('self_and_peers'),
    managersRule: text('managers_rule', { enum: ACCESS_MANAGER_ASSIGNMENT_RULES })
      .notNull()
      .default('any_at_or_below'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('access_assignment_rules_tenant_org_area_unique').on(
      t.tenantId,
      t.organizationId,
      t.area,
    ),
    foreignKey({
      name: 'access_assignment_rules_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    check('access_assignment_rules_area_check', sql`${t.area} in ('leads', 'opportunities')`),
    check(
      'access_assignment_rules_staff_rule_check',
      sql`${t.staffRule} in ('self_and_peers', 'self_only', 'any_at_or_below')`,
    ),
    check(
      'access_assignment_rules_managers_rule_check',
      sql`${t.managersRule} in ('any_at_or_below', 'self_and_staff')`,
    ),
  ],
);

/** Entity-owned directed cross-department hand-over pairs for assignment in an area. */
export const accessAssignmentHandovers = appSchema.table(
  'access_assignment_handovers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    area: text('area', { enum: ACCESS_ASSIGNMENT_AREAS }).notNull(),
    fromDepartmentId: uuid('from_department_id').notNull(),
    toDepartmentId: uuid('to_department_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('access_assignment_handovers_tenant_org_area_pair_unique').on(
      t.tenantId,
      t.organizationId,
      t.area,
      t.fromDepartmentId,
      t.toDepartmentId,
    ),
    foreignKey({
      name: 'access_assignment_handovers_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'access_assignment_handovers_from_department_fk',
      columns: [t.tenantId, t.organizationId, t.fromDepartmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    foreignKey({
      name: 'access_assignment_handovers_to_department_fk',
      columns: [t.tenantId, t.organizationId, t.toDepartmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    index('access_assignment_handovers_tenant_org_area_idx').on(
      t.tenantId,
      t.organizationId,
      t.area,
    ),
    check('access_assignment_handovers_area_check', sql`${t.area} in ('leads', 'opportunities')`),
    check(
      'access_assignment_handovers_distinct_departments_check',
      sql`${t.fromDepartmentId} <> ${t.toDepartmentId}`,
    ),
  ],
);
