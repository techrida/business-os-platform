// Audit tables (migration 0001_audit). This file describes them to Drizzle so reads are typed; the SQL in
// packages/db/migrations/0001_audit.sql is the source of truth, because it also holds what Drizzle cannot
// model (the hash chain functions, the audit_capture trigger, the append-only triggers and the privileges).
// Serves the NFR "every change is audited, and the trail is tamper-evident" (ADR 0020).
//
// bos_app has no privilege on these tables: it appends through audit.record() and reads through
// audit.read_events() / audit.verify_chain(). These definitions are for typing those results and for
// bos_owner tooling, not for direct inserts from the API.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  date,
  index,
  inet,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Mirrors AUDIT_ACTOR_KINDS in @bos/contracts (this package does not depend on contracts). */
const AUDIT_ACTOR_KINDS = ['user', 'system', 'zitadel', 'seed'] as const;

/** The `audit` schema: append-only evidence, kept apart from business data in `app`. */
export const auditSchema = pgSchema('audit');

/** Postgres `bytea` as a Node Buffer (drizzle-orm 0.45 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * One row per audited change, chained per (tenant, UTC month): `hash` = SHA-256 over `prevHash` and the
 * row's canonical text (audit.event_hash in SQL). `id` is a bigint, so it is read as a JS bigint.
 */
export const auditEvents = auditSchema.table(
  'audit_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    /** First day of the UTC month (YYYY-MM-DD) whose chain the row belongs to. */
    chainMonth: date('chain_month', { mode: 'string' }).notNull(),
    /** 1, 2, 3, ... inside the (tenant, month) chain, with no gaps. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: text('actor_kind', { enum: AUDIT_ACTOR_KINDS }).notNull(),
    actorId: text('actor_id').notNull(),
    /** `<table>.insert|update|delete` for row changes, a domain name such as `approval.approved` otherwise. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    meta: jsonb('meta'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    correlationId: text('correlation_id').notNull(),
    prevHash: bytea('prev_hash').notNull(),
    hash: bytea('hash').notNull(),
  },
  (t) => [
    unique('audit_events_chain_unique').on(t.tenantId, t.chainMonth, t.seq),
    check(
      'audit_events_actor_kind_check',
      sql`${t.actorKind} in ('user', 'system', 'zitadel', 'seed')`,
    ),
    index('audit_events_entity_idx').on(
      t.tenantId,
      t.organizationId,
      t.entityType,
      t.entityId,
      t.id,
    ),
  ],
);

/** The tail of a closed month's chain, written once by the monthly seal job. */
export const chainSeals = auditSchema.table(
  'chain_seals',
  {
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    chainMonth: date('chain_month', { mode: 'string' }).notNull(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull(),
    lastHash: bytea('last_hash').notNull(),
    sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'chain_seals_pkey', columns: [t.tenantId, t.chainMonth] })],
);
