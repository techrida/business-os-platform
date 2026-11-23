// Drizzle tables for migration 0004_documents (uploaded files). Owner: U4.
// The SQL in migrations/0004_documents.sql stays the source of truth: it also holds the two triggers that
// freeze a clean version and block its deletion, which Drizzle cannot model. Keep the two in step.
// ADR 0027 section 8 (migration 0014_composite_keys): parent keys and composite foreign keys that carry
// tenant_id and organization_id, so a child can never point at another entity's row.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { appSchema, organizations, tenants } from './platform.js';

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
  (t): PgTableExtraConfigValue[] => [
    index('documents_owner_idx').on(t.tenantId, t.organizationId, t.ownerType, t.ownerId),
    // Parent keys for the composite FKs (ADR 0027 section 8).
    unique('documents_tenant_id_unique').on(t.tenantId, t.id),
    unique('documents_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'documents_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    // MATCH SIMPLE: not checked while current_version_id is NULL.
    foreignKey({
      name: 'documents_current_version_fk',
      columns: [t.tenantId, t.organizationId, t.currentVersionId],
      foreignColumns: [
        documentVersions.tenantId,
        documentVersions.organizationId,
        documentVersions.id,
      ],
    }),
  ],
);

/** One uploaded content with its own scan status. The bytes live on the files volume, not here. */
export const documentVersions = appSchema.table(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
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
  (t): PgTableExtraConfigValue[] => [
    unique('document_versions_review_identity_unique').on(
      t.tenantId,
      t.organizationId,
      t.documentId,
      t.id,
    ),
    unique('document_versions_tenant_document_version_unique').on(
      t.tenantId,
      t.documentId,
      t.version,
    ),
    // Parent keys for the composite FKs (ADR 0027 section 8).
    unique('document_versions_tenant_id_unique').on(t.tenantId, t.id),
    unique('document_versions_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    foreignKey({
      name: 'document_versions_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'document_versions_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    index('document_versions_document_idx').on(t.tenantId, t.organizationId, t.documentId),
    check('document_versions_size_check', sql`${t.sizeBytes} >= 0 AND ${t.sizeBytes} <= 26214400`),
  ],
);

/** Mirrors the owner types the invoice and purchase-order render sweepers use (the quotation keeps its own state). */
export const DOCUMENT_RENDER_FAILURE_OWNER_TYPES = ['invoice', 'purchase_order_version'] as const;

/**
 * Migration 0115. A PDF render of an invoice or a purchase-order version that failed since its last success: how many
 * tries failed, the last failure's fixed kind word, and when the sweeper may try again (`next_attempt_at`), or that it
 * gave up (`exhausted_at`; exactly one of the two is set). The render sweepers write it; the Retry routes delete it.
 */
export const documentRenderFailures = appSchema.table(
  'document_render_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    ownerType: text('owner_type', { enum: DOCUMENT_RENDER_FAILURE_OWNER_TYPES }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    attempts: integer('attempts').notNull(),
    lastFailureKind: text('last_failure_kind').notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('document_render_failures_tenant_id_unique').on(t.tenantId, t.id),
    unique('document_render_failures_owner_unique').on(
      t.tenantId,
      t.organizationId,
      t.ownerType,
      t.ownerId,
    ),
    foreignKey({
      name: 'document_render_failures_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    check(
      'document_render_failures_owner_type_check',
      sql`${t.ownerType} IN ('invoice', 'purchase_order_version')`,
    ),
    check('document_render_failures_attempts_check', sql`${t.attempts} >= 1`),
    check('document_render_failures_kind_check', sql`${t.lastFailureKind} ~ '^[a-z0-9_]{1,64}$'`),
    check(
      'document_render_failures_state_check',
      sql`(${t.exhaustedAt} IS NULL) <> (${t.nextAttemptAt} IS NULL)`,
    ),
    index('document_render_failures_due_idx').on(t.ownerType, t.nextAttemptAt),
  ],
);

/** The slot a logo image fills; mirrors the entity logo owner types (entity_logo, entity_logo_on_dark, entity_logo_on_light). */
export const LOGO_IMAGE_VARIANTS = ['primary', 'on_dark', 'on_light'] as const;

/**
 * What a company logo image measures (migration 0218, R6AC): alpha-weighted mean relative luminance and whether it has
 * transparent pixels. Measured at upload; a cache, since a render that finds no row measures the bytes itself.
 */
export const logoImageStats = appSchema.table(
  'logo_image_stats',
  {
    tenantId: uuid('tenant_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    documentId: uuid('document_id').notNull(),
    variant: text('variant', { enum: LOGO_IMAGE_VARIANTS }).notNull(),
    luminance: real('luminance').notNull(),
    hasTransparency: boolean('has_transparency').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'logo_image_stats_pk',
      columns: [t.tenantId, t.organizationId, t.documentId],
    }),
    foreignKey({
      name: 'logo_image_stats_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'logo_image_stats_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    check(
      'logo_image_stats_variant_check',
      sql`${t.variant} IN ('primary', 'on_dark', 'on_light')`,
    ),
    check('logo_image_stats_luminance_check', sql`${t.luminance} >= 0 AND ${t.luminance} <= 1`),
  ],
);
