import { sql } from 'drizzle-orm';
import {
  integer,
  text,
  timestamp,
  uuid,
  jsonb,
  unique,
  foreignKey,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { documentVersions } from './documents.js';
import { appSchema, tenants } from './platform.js';
import { users } from './identity.js';
import { verificationCases } from './crm.js';

export const verificationReviewEvents = appSchema.table(
  'verification_review_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    caseId: uuid('case_id').notNull(),
    caseVersion: integer('case_version').notNull(),
    round: integer('round').notNull(),
    kind: text('kind', { enum: ['item_decided', 'case_decided', 'legacy_case_decided'] }).notNull(),
    itemKey: text('item_key'),
    decision: text('decision', { enum: ['approve', 'reject'] }).notNull(),
    comment: text('comment'),
    actorUserId: uuid('actor_user_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    evidence: jsonb('evidence'),
    evidenceOrganizationId: uuid('evidence_organization_id'),
    documentId: uuid('document_id'),
    documentVersionId: uuid('document_version_id'),
  },
  (t) => [
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id] }),
    foreignKey({
      columns: [t.tenantId, t.evidenceOrganizationId, t.documentId, t.documentVersionId],
      foreignColumns: [
        documentVersions.tenantId,
        documentVersions.organizationId,
        documentVersions.documentId,
        documentVersions.id,
      ],
    }),
    unique('verification_review_events_case_version_unique').on(
      t.tenantId,
      t.caseId,
      t.caseVersion,
    ),
    foreignKey({
      columns: [t.tenantId, t.caseId],
      foreignColumns: [verificationCases.tenantId, verificationCases.id],
    }),
    foreignKey({
      columns: [t.tenantId, t.actorUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('verification_review_events_round_check', sql`${t.round} >= 0`),
    index('verification_review_events_history_idx').on(t.tenantId, t.caseId, t.occurredAt, t.id),
  ],
);
