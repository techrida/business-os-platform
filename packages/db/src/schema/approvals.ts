// Drizzle tables for migration 0006_approvals (owner: U7). The SQL in migrations/0006_approvals.sql is
// the source of truth (it also holds the spec-immutable trigger and the partial unique index); this file
// only describes the tables so queries are typed. Keep the two in step.
// ADR 0027 section 8 (migration 0014_composite_keys): every entity-owned parent has UNIQUE (tenant_id, id) and
// UNIQUE (tenant_id, organization_id, id), and every child foreign key carries tenant_id and organization_id,
// so a row can never point at another entity's (or another tenant's) row.
import {
  type AnyPgColumn,
  bigint,
  customType,
  foreignKey,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, organizations } from './platform.js';

/** Postgres bytea as a Node Buffer (snapshot and request hashes). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tz = (name: string) => timestamp(name, { withTimezone: true });
const tenancy = () => ({
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
});

/** The (tenant_id, organization_id) -> organizations (tenant_id, id) FK that every entity-owned table has. */
const tenantOrgFk = (table: string, t: { tenantId: AnyPgColumn; organizationId: AnyPgColumn }) =>
  foreignKey({
    name: `${table}_tenant_org_fk`,
    columns: [t.tenantId, t.organizationId],
    foreignColumns: [organizations.tenantId, organizations.id],
  });

/** The two parent keys an entity-owned table offers to its children. */
const parentKeys = (
  table: string,
  t: { tenantId: AnyPgColumn; organizationId: AnyPgColumn; id: AnyPgColumn },
) => [
  unique(`${table}_tenant_id_unique`).on(t.tenantId, t.id),
  unique(`${table}_tenant_org_id_unique`).on(t.tenantId, t.organizationId, t.id),
];

export const WORKFLOW_VERSION_STATUSES = ['draft', 'published', 'retired'] as const;
export const APPROVAL_REQUEST_STATUSES = [
  'pending',
  'approved',
  'returned',
  'rejected',
  'blocked',
  'cancelled',
] as const;
export const APPROVAL_STEP_STATUSES = [
  'waiting',
  'active',
  'approved',
  'returned',
  'rejected',
  'skipped',
] as const;
// 0030: department_head (P4 K1). Its row carries the head it resolved to (user_id) or its fallback
// role (role_key), exactly one of them.
export const APPROVAL_STEP_KINDS = ['role', 'group', 'user', 'department_head'] as const;
export const APPROVAL_ACTIONS = [
  'submit',
  'approve',
  'return',
  'reject',
  'escalate',
  'remind',
  'block',
  'reroute',
  // 0017: a module withdrew the request (ApprovalsService.cancel).
  'cancel',
] as const;

export const workflowDefinitions = appSchema.table(
  'workflow_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    documentType: text('document_type').notNull(),
    currentVersionId: uuid('current_version_id'),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    ...parentKeys('workflow_definitions', t),
    tenantOrgFk('workflow_definitions', t),
    // MATCH SIMPLE: not checked while current_version_id is NULL.
    foreignKey({
      name: 'workflow_definitions_current_version_fk',
      columns: [t.tenantId, t.organizationId, t.currentVersionId],
      foreignColumns: [
        workflowVersions.tenantId,
        workflowVersions.organizationId,
        workflowVersions.id,
      ],
    }),
  ],
);

export const workflowVersions = appSchema.table(
  'workflow_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    definitionId: uuid('definition_id').notNull(),
    version: integer('version').notNull(),
    status: text('status', { enum: WORKFLOW_VERSION_STATUSES }).notNull().default('draft'),
    spec: jsonb('spec').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    /** Who saved this version (0127). Null before 0127; such a draft is refused at publish until saved again. */
    createdBy: uuid('created_by'),
    publishedAt: tz('published_at'),
    publishedBy: uuid('published_by'),
  },
  (t): PgTableExtraConfigValue[] => [
    ...parentKeys('workflow_versions', t),
    unique('workflow_versions_tenant_definition_version_unique').on(
      t.tenantId,
      t.definitionId,
      t.version,
    ),
    tenantOrgFk('workflow_versions', t),
    foreignKey({
      name: 'workflow_versions_definition_fk',
      columns: [t.tenantId, t.organizationId, t.definitionId],
      foreignColumns: [
        workflowDefinitions.tenantId,
        workflowDefinitions.organizationId,
        workflowDefinitions.id,
      ],
    }),
  ],
);

export const approvalGroups = appSchema.table(
  'approval_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [...parentKeys('approval_groups', t), tenantOrgFk('approval_groups', t)],
);

export const approvalGroupMembers = appSchema.table(
  'approval_group_members',
  {
    /** Not the primary key (that is tenant_id + group_id + user_id) but unique: the audit trigger identifies rows by id. */
    id: uuid('id').notNull().defaultRandom(),
    ...tenancy(),
    groupId: uuid('group_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'approval_group_members_tenant_group_user_pk',
      columns: [t.tenantId, t.groupId, t.userId],
    }),
    unique('approval_group_members_id_unique').on(t.id),
    tenantOrgFk('approval_group_members', t),
    foreignKey({
      name: 'approval_group_members_group_fk',
      columns: [t.tenantId, t.organizationId, t.groupId],
      foreignColumns: [approvalGroups.tenantId, approvalGroups.organizationId, approvalGroups.id],
    }).onDelete('cascade'),
  ],
);

export const delegations = appSchema.table(
  'delegations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    fromUserId: uuid('from_user_id').notNull(),
    toUserId: uuid('to_user_id').notNull(),
    startsAt: tz('starts_at').notNull(),
    endsAt: tz('ends_at').notNull(),
    documentType: text('document_type'),
    createdBy: uuid('created_by').notNull(),
    createdAt: tz('created_at').notNull().defaultNow(),
    revokedAt: tz('revoked_at'),
  },
  (t) => [tenantOrgFk('delegations', t)],
);

export const approvalRequests = appSchema.table(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    definitionId: uuid('definition_id').notNull(),
    workflowVersionId: uuid('workflow_version_id').notNull(),
    documentType: text('document_type').notNull(),
    documentId: uuid('document_id').notNull(),
    documentNumber: text('document_number').notNull(),
    title: text('title').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    snapshotSha256: bytea('snapshot_sha256').notNull(),
    facts: jsonb('facts').notNull(),
    requesterUserId: uuid('requester_user_id').notNull(),
    sodUserIds: uuid('sod_user_ids').array().notNull(),
    status: text('status', { enum: APPROVAL_REQUEST_STATUSES }).notNull(),
    blockReason: text('block_reason'),
    currentSeq: integer('current_seq').notNull(),
    version: integer('version').notNull().default(1),
    submittedAt: tz('submitted_at').notNull().defaultNow(),
    decidedAt: tz('decided_at'),
  },
  (t) => [
    ...parentKeys('approval_requests', t),
    tenantOrgFk('approval_requests', t),
    foreignKey({
      name: 'approval_requests_definition_fk',
      columns: [t.tenantId, t.organizationId, t.definitionId],
      foreignColumns: [
        workflowDefinitions.tenantId,
        workflowDefinitions.organizationId,
        workflowDefinitions.id,
      ],
    }),
    foreignKey({
      name: 'approval_requests_workflow_version_fk',
      columns: [t.tenantId, t.organizationId, t.workflowVersionId],
      foreignColumns: [
        workflowVersions.tenantId,
        workflowVersions.organizationId,
        workflowVersions.id,
      ],
    }),
  ],
);

export const approvalSteps = appSchema.table(
  'approval_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    requestId: uuid('request_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: APPROVAL_STEP_KINDS }).notNull(),
    roleKey: text('role_key'),
    groupId: uuid('group_id'),
    userId: uuid('user_id'),
    reason: text('reason').notNull(),
    status: text('status', { enum: APPROVAL_STEP_STATUSES }).notNull().default('waiting'),
    activatedAt: tz('activated_at'),
    remindAt: tz('remind_at'),
    escalateAt: tz('escalate_at'),
    remindedAt: tz('reminded_at'),
    escalatedAt: tz('escalated_at'),
    decidedBy: uuid('decided_by'),
    decidedOnBehalfOf: uuid('decided_on_behalf_of'),
    decidedAt: tz('decided_at'),
  },
  (t) => [
    ...parentKeys('approval_steps', t),
    unique('approval_steps_tenant_request_seq_unique').on(t.tenantId, t.requestId, t.seq),
    tenantOrgFk('approval_steps', t),
    foreignKey({
      name: 'approval_steps_request_fk',
      columns: [t.tenantId, t.organizationId, t.requestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    // MATCH SIMPLE: not checked while group_id is NULL.
    foreignKey({
      name: 'approval_steps_group_fk',
      columns: [t.tenantId, t.organizationId, t.groupId],
      foreignColumns: [approvalGroups.tenantId, approvalGroups.organizationId, approvalGroups.id],
    }),
  ],
);

export const approvalActions = appSchema.table(
  'approval_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ...tenancy(),
    requestId: uuid('request_id').notNull(),
    stepId: uuid('step_id'),
    actorUserId: uuid('actor_user_id'),
    onBehalfOfUserId: uuid('on_behalf_of_user_id'),
    action: text('action', { enum: APPROVAL_ACTIONS }).notNull(),
    comment: text('comment'),
    idempotencyKey: text('idempotency_key'),
    requestHash: bytea('request_hash'),
    requestVersion: integer('request_version').notNull(),
    result: jsonb('result'),
    createdAt: tz('created_at').notNull().defaultNow(),
    // Insertion order (0161): breaks ties between rows of one transaction, which share created_at.
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  },
  (t) => [
    tenantOrgFk('approval_actions', t),
    foreignKey({
      name: 'approval_actions_request_fk',
      columns: [t.tenantId, t.organizationId, t.requestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    // MATCH SIMPLE: not checked while step_id is NULL.
    foreignKey({
      name: 'approval_actions_step_fk',
      columns: [t.tenantId, t.organizationId, t.stepId],
      foreignColumns: [approvalSteps.tenantId, approvalSteps.organizationId, approvalSteps.id],
    }),
  ],
);
