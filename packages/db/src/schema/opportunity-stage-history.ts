// Drizzle table for migration 0162_opportunity_stage_history: one row per opportunity stage change. The SQL in the
// migration is the source of truth; this file only types the queries. Append-only: bos_app inserts and selects.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { OPPORTUNITY_STAGES, opportunities } from './crm.js';
import { users } from './identity.js';
import { appSchema, organizations, tenants } from './platform.js';

/** The transaction actor kinds (bos.actor_kind). Only 'user' carries actor_user_id. */
export const STAGE_HISTORY_ACTOR_KINDS = ['user', 'system', 'seed', 'zitadel'] as const;

export const opportunityStageHistory = appSchema.table(
  'opportunity_stage_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),
    fromStage: text('from_stage', { enum: OPPORTUNITY_STAGES }).notNull(),
    toStage: text('to_stage', { enum: OPPORTUNITY_STAGES }).notNull(),
    actorKind: text('actor_kind', { enum: STAGE_HISTORY_ACTOR_KINDS }).notNull(),
    /** The user who made the change, or who set off a system move; null when no user is behind it. */
    actorUserId: uuid('actor_user_id'),
    /** The transaction time: moves in one transaction share it, and seq orders them. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
  },
  (t) => [
    unique('opportunity_stage_history_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'opportunity_stage_history_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'opportunity_stage_history_opportunity_fk',
      columns: [t.tenantId, t.organizationId, t.opportunityId],
      foreignColumns: [opportunities.tenantId, opportunities.organizationId, opportunities.id],
    }),
    foreignKey({
      name: 'opportunity_stage_history_actor_user_fk',
      columns: [t.tenantId, t.actorUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'opportunity_stage_history_from_stage_check',
      sql`${t.fromStage} in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation', 'won', 'lost', 'on_hold')`,
    ),
    check(
      'opportunity_stage_history_to_stage_check',
      sql`${t.toStage} in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation', 'won', 'lost', 'on_hold')`,
    ),
    check('opportunity_stage_history_change_check', sql`${t.fromStage} <> ${t.toStage}`),
    check(
      'opportunity_stage_history_actor_check',
      sql`${t.actorKind} in ('user', 'system', 'seed', 'zitadel') AND (${t.actorKind} = 'user') = (${t.actorUserId} IS NOT NULL)`,
    ),
    index('opportunity_stage_history_opportunity_idx').on(
      t.tenantId,
      t.opportunityId,
      t.createdAt,
      t.seq,
    ),
  ],
);
