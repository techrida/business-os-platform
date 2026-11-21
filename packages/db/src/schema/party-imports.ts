// Drizzle table for migration 0176_party_import_batches: the record of a customer or vendor CSV import (round 5, K1).
// The SQL migration is the source of truth; this file only types the queries, so keep the two in step. Entity-owned.
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './identity.js';
import { appSchema, organizations, tenants } from './platform.js';

export const PARTY_IMPORT_BATCH_KINDS = ['customer', 'vendor'] as const;
export const PARTY_IMPORT_BATCH_STATUSES = ['previewed', 'committed', 'expired'] as const;

export const partyImportBatches = appSchema.table(
  'party_import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    kind: text('kind', { enum: PARTY_IMPORT_BATCH_KINDS }).notNull(),
    status: text('status', { enum: PARTY_IMPORT_BATCH_STATUSES }).notNull().default('previewed'),
    fileName: text('file_name').notNull(),
    rowCount: integer('row_count').notNull(),
    validCount: integer('valid_count').notNull(),
    createdCount: integer('created_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull(),
    errorCount: integer('error_count').notNull(),
    /** One element per data line: line, name, pan, status, issues, values, recordId (the contracts' PartyImportRow). */
    rows: jsonb('rows').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    committedBy: uuid('committed_by'),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [
    unique('party_import_batches_tenant_id_unique').on(t.tenantId, t.id),
    unique('party_import_batches_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'party_import_batches_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'party_import_batches_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'party_import_batches_committed_by_fk',
      columns: [t.tenantId, t.committedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('party_import_batches_tenant_org_created_idx').on(
      t.tenantId,
      t.organizationId,
      t.createdAt,
    ),
    // 0185: the daily expiry job reads the previewed batches oldest first.
    index('party_import_batches_previewed_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'previewed'`),
    check('party_import_batches_kind_check', sql`${t.kind} in ('customer', 'vendor')`),
    check(
      'party_import_batches_status_check',
      sql`${t.status} in ('previewed', 'committed', 'expired')`,
    ),
    check(
      'party_import_batches_file_name_check',
      sql`btrim(${t.fileName}) <> '' AND length(${t.fileName}) <= 200`,
    ),
    check(
      'party_import_batches_counts_check',
      sql`${t.rowCount} between 0 and 2000 AND ${t.validCount} >= 0 AND ${t.createdCount} >= 0 AND ${t.duplicateCount} >= 0 AND ${t.errorCount} >= 0 AND ${t.rowCount} = ${t.validCount} + ${t.createdCount} + ${t.duplicateCount} + ${t.errorCount}`,
    ),
    check(
      'party_import_batches_rows_check',
      sql`jsonb_typeof(${t.rows}) = 'array' AND (${t.status} = 'expired' OR jsonb_array_length(${t.rows}) = ${t.rowCount})`,
    ),
    check(
      'party_import_batches_committed_check',
      sql`(${t.status} = 'committed') = (${t.committedAt} IS NOT NULL AND ${t.committedBy} IS NOT NULL)`,
    ),
  ],
);
