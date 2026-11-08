// Drizzle tables for migration 0004_documents (uploaded files). Owner: U4.
// The SQL in migrations/0004_documents.sql stays the source of truth: it also holds the two triggers that
// freeze a clean version and block its deletion, which Drizzle cannot model. Keep the two in step.
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  index,
  integer,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema } from './platform.js';

/** Postgres bytea as a Node Buffer (used for the SHA-256 of the content). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Mirrors DOCUMENT_VERSION_STATUSES in @bos/contracts (the db package does not depend on contracts). */
export const DOCUMENT_STATUSES = [
  'awaiting_content',
  'quarantined',
  'clean',
  'infected',
  'rejected',
  'scan_failed',
] as const;

/** One logical file attached to an owner record (owner_type + owner_id). */
export const documents = appSchema.table(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    /** The newest clean version; null until the first version has passed the scan. */
    currentVersionId: uuid('current_version_id'),
    createdBy: uuid('created_by'),
    /**
     * Soft remove (migration 0010): set when someone who may edit the owner takes the attachment away. The rows
     * and files of a clean version stay for the audit trail; a removed document is invisible everywhere else.
     */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_owner_idx').on(t.tenantId, t.organizationId, t.ownerType, t.ownerId)],
);

/** One uploaded content with its own scan status. The bytes live on the files volume, not here. */
export const documentVersions = appSchema.table(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id),
    version: integer('version').notNull(),
    filename: text('filename').notNull(),
    declaredMime: text('declared_mime').notNull(),
    detectedMime: text('detected_mime'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: bytea('sha256'),
    /** "<tenant_id>/<version_id>", the same relative path under quarantine/ and clean/. */
    storageKey: text('storage_key').notNull(),
    status: text('status', { enum: DOCUMENT_STATUSES }).notNull().default('awaiting_content'),
    scanSignature: text('scan_signature'),
    scanEngine: text('scan_engine'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_versions_document_version_unique').on(t.documentId, t.version),
    index('document_versions_document_idx').on(t.tenantId, t.organizationId, t.documentId),
    check('document_versions_size_check', sql`${t.sizeBytes} >= 0 AND ${t.sizeBytes} <= 26214400`),
  ],
);
