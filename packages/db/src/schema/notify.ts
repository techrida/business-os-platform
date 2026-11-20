// Drizzle tables for migration 0005_notify: the in-app bell (notifications) and the email outbox (outbox).
// Serves the Reliability NFR: the outbox row commits with the business change, a worker sends it later.
// The SQL in migrations/0005_notify.sql is the source of truth; this file only types the queries, so keep
// the two in step (a change is a new migration, never an edit of 0005). Both tables are on the check-audit
// allowlist, so neither has an audit trigger.
// ADR 0027 section 8 (migration 0014_composite_keys): composite FKs carry tenant_id, so a row can only point at
// an entity and a user of its own tenant.
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { appSchema, organizations, tenants } from './platform.js';

/** Mirrors the outbox status CHECK. `sending` = claimed by a drainer; `dead` = out of retries. */
export const OUTBOX_STATUSES = ['pending', 'sending', 'sent', 'dead'] as const;

/** What the workspace bell and inbox read. */
export const notifications = appSchema.table(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    userId: uuid('user_id').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** A workspace path such as /inbox/<id>; never an absolute URL. */
    link: text('link').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /** Chosen by the caller so a retried business action does not notify the same user twice. */
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('notifications_tenant_user_dedupe_unique').on(t.tenantId, t.userId, t.dedupeKey),
    foreignKey({
      name: 'notifications_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'notifications_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('notifications_tenant_user_read_idx').on(t.tenantId, t.userId, t.readAt),
    index('notifications_tenant_user_created_idx').on(
      t.tenantId,
      t.userId,
      sql`${t.createdAt} desc`,
    ),
  ],
);

/** One email waiting to be sent (or already sent / dead). */
export const outbox = appSchema.table(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: ['email'] }).notNull(),
    template: text('template').notNull(),
    toUserId: uuid('to_user_id'),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    bodyHtml: text('body_html'),
    /** Per recipient: the service builds it as `${dedupeKey}:${userId}`. Unique per tenant. */
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status', { enum: OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a drainer claims the row; an old value on a `sending` row means the drainer crashed. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    lastError: text('last_error'),
    providerMessageId: text('provider_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /**
     * How many times someone resent this row from the delivery log (migration 0128). The drainer puts it in
     * the dead-letter notice's dedupe key, so a resent email that dies again notifies the Founder again.
     */
    resendCount: integer('resend_count').notNull().default(0),
  },
  (t) => [
    unique('outbox_tenant_dedupe_unique').on(t.tenantId, t.dedupeKey),
    foreignKey({
      name: 'outbox_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    // MATCH SIMPLE: not checked while to_user_id is NULL.
    foreignKey({
      name: 'outbox_to_user_fk',
      columns: [t.tenantId, t.toUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('outbox_kind_check', sql`${t.kind} in ('email')`),
    check('outbox_status_check', sql`${t.status} in ('pending', 'sending', 'sent', 'dead')`),
    // Not tenant-leading on purpose: the drainer looks for due rows across all tenants.
    index('outbox_pending_next_attempt_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('outbox_sending_claimed_idx')
      .on(t.claimedAt)
      .where(sql`${t.status} = 'sending'`),
  ],
);
