// Drizzle table for migration 0012_idempotency_keys (owner: N4). The SQL in migrations/0012_idempotency_keys.sql
// is the source of truth (it also holds the audit trigger); this file only describes the table so queries are
// typed. Keep the two in step.
import {
  customType,
  foreignKey,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, organizations, tenants } from './platform.js';

/** Postgres bytea as a Node Buffer (the request hash). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const idempotencyKeys = appSchema.table(
  'idempotency_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    /** bos.actor_id: a user uuid, or `system:<job>`. */
    actorId: text('actor_id').notNull(),
    command: text('command').notNull(),
    key: text('key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    /** HTTP status of the stored answer; NULL while the first call is still running. */
    status: integer('status'),
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('idempotency_keys_unique').on(t.tenantId, t.organizationId, t.actorId, t.command, t.key),
    // ADR 0027 section 8 (migration 0014_composite_keys): the entity must belong to the row's tenant.
    foreignKey({
      name: 'idempotency_keys_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
  ],
);
