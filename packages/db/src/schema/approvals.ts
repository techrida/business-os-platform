// Drizzle tables for migration 0006_approvals (owner: U7). The SQL in migrations/0006_approvals.sql is
// the source of truth (it also holds the spec-immutable trigger and the partial unique index); this file
// only describes the tables so queries are typed. Keep the two in step.
import { customType, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { appSchema } from './platform.js';

/** Postgres bytea as a Node Buffer (snapshot and request hashes). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tz = (name: string) => timestamp(name, { withTimezone: true });
const tenancy = () => ({
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
});

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
export const APPROVAL_STEP_KINDS = ['role', 'group', 'user'] as const;
export const APPROVAL_ACTIONS = [
  'submit',
  'approve',
  'return',
  'reject',
  'escalate',
  'remind',
  'block',
  'reroute',
] as const;

export const workflowDefinitions = appSchema.table('workflow_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ...tenancy(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  documentType: text('document_type').notNull(),
  currentVersionId: uuid('current_version_id'),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const workflowVersions = appSchema.table('workflow_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  ...tenancy(),
  definitionId: uuid('definition_id').notNull(),
  version: integer('version').notNull(),
  status: text('status', { enum: WORKFLOW_VERSION_STATUSES }).notNull().default('draft'),
  spec: jsonb('spec').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  publishedAt: tz('published_at'),
  publishedBy: uuid('published_by'),
});

export const approvalGroups = appSchema.table('approval_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  ...tenancy(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const approvalGroupMembers = appSchema.table('approval_group_members', {
  id: uuid('id').notNull().defaultRandom(),
  ...tenancy(),
  groupId: uuid('group_id').notNull(),
  userId: uuid('user_id').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const delegations = appSchema.table('delegations', {
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
});

export const approvalRequests = appSchema.table('approval_requests', {
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
});

export const approvalSteps = appSchema.table('approval_steps', {
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
});

export const approvalActions = appSchema.table('approval_actions', {
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
});
