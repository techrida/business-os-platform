// Drizzle tables for migration 0016_quotations: tax codes, payment terms and quotations with their immutable,
// numbered versions (P2 unit S2). Serves the NFR "amounts are exact": money is numeric(18,2), quantities
// numeric(18,4) and FX rates numeric(18,6), all read as strings; wrap them in decimal.js, never Number().
// The SQL in migrations/0016_quotations.sql is the source of truth; this file only types the queries, so keep the
// two in step (a change is a new migration, never an edit of an old one). quotations-schema.test.ts compares them,
// and pins the live statuses and the material-column lists below to the SQL.
// tax_codes and payment_terms are tenant-level (ADR 0027 section 6); the other seven are entity-owned.
// Not modelled here: the EXCLUDE constraint tax_codes_no_overlap (Drizzle 0.45 has no EXCLUDE), the freeze
// triggers, and the three FKs 0016 adds to S1 tables (party_accounts, opportunities, activities), which live in
// SQL only so that crm.ts keeps mirroring 0015.
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from './approvals.js';
import { customerContacts, customers, opportunities } from './crm.js';
import { documents } from './documents.js';
import { departments, users } from './identity.js';
import { appSchema, organizations, parties, tenants } from './platform.js';

/** Postgres bytea as a Node Buffer (drizzle-orm 0.45 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

// These mirror the catalogues in @bos/contracts quotations.ts (the db package does not depend on contracts).
export const QUOTATION_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
  'superseded',
] as const;
/**
 * The statuses of one_live_version: at most one version per quotation is in one of these. Exactly the contracts'
 * QUOTATION_REVISION_RULES.liveStatuses; every other status is terminal, except that cancelling an unsent revision
 * (R6D, CancelService.restoreReplaced) moves the Superseded version it replaced back to Approved or Sent once the
 * draft has left this set. (This note lives here, not in 0016_quotations.sql: released migration files never change.)
 */
export const QUOTATION_LIVE_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'approved',
  'sent',
] as const;
/** The statuses in which a version, its lines, tax summary and editors may change (editableStatuses). */
export const QUOTATION_EDITABLE_STATUSES = ['draft', 'returned'] as const;
export const QUOTATION_REJECTION_SOURCES = ['internal', 'customer'] as const;
export const QUOTATION_DISCOUNT_MODES = ['pct', 'amount'] as const;
export const QUOTATION_RENDER_STATES = ['none', 'pending', 'rendered', 'failed'] as const;
export const QUOTATION_ACCEPTANCE_OUTCOMES = ['accepted', 'rejected'] as const;
export const QUOTATION_ACTOR_KINDS = ['staff', 'customer_user'] as const;
export const QUOTATION_EVIDENCE_KINDS = ['contract', 'purchase_order', 'signed_quote'] as const;
export const TAX_CODE_KINDS = ['vat', 'exempt', 'zero', 'reverse_charge'] as const;

/** quotation_versions columns that never change after INSERT, whatever the status. */
export const QUOTATION_VERSION_IMMUTABLE_COLUMNS = [
  'id',
  'tenant_id',
  'organization_id',
  'quotation_id',
  'revision_no',
  'supersedes_version_id',
  'created_at',
] as const;
/**
 * quotation_versions columns frozen once the status is not draft or returned (A2 section 2.3): the content,
 * the priced totals, the FX snapshot and the hashes. The submit UPDATE writes the snapshot and hashes together
 * with the status, while the old status is still draft or returned.
 */
export const QUOTATION_VERSION_MATERIAL_COLUMNS = [
  'contact_id',
  'template_id',
  'currency',
  'issue_date',
  'valid_until',
  'scope',
  'assumptions',
  'exclusions',
  'terms_and_conditions',
  'delivery_timeline',
  'payment_term_id',
  'payment_schedule',
  'discount_mode',
  'discount_input',
  'subtotal',
  'discount_amount',
  'taxable_amount',
  'tax_amount',
  'total',
  'effective_discount_pct',
  'fx_rate',
  'fx_source',
  'fx_date',
  'amount_npr',
  'npr_taxable_amount',
  'internal_cost_total',
  'margin_pct',
  'calc_version',
  'content_sha256',
  'snapshot_sha256',
  'revision_reason',
] as const;
/** quotation_versions columns that stay updatable after submit: status, timestamps, reasons, links, rendering. */
export const QUOTATION_VERSION_UPDATABLE_COLUMNS = [
  'status',
  'rejection_source',
  'approval_request_id',
  'rendered_document_id',
  'rendered_sha256',
  'render_state',
  'render_attempts',
  'document_style',
  'superseded_by_version_id',
  'cancel_reason',
  'submitted_at',
  'approved_at',
  'sent_at',
  'accepted_at',
  'rejected_at',
  'expired_at',
  'cancelled_at',
  'version',
  'updated_at',
] as const;

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });

// ---------------------------------------------------------------------------------------------------------------
// Tenant-level tables
// ---------------------------------------------------------------------------------------------------------------

/**
 * One effective period of a tax code (C-8): [effectiveFrom, effectiveTo), effectiveTo null = open-ended. Periods
 * of one code never overlap in a tenant (the SQL-only EXCLUDE constraint tax_codes_no_overlap). `rateBp` is basis
 * points (1300 = 13%): zero exactly for exempt and zero-rated codes.
 */
export const taxCodes = appSchema.table(
  'tax_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: TAX_CODE_KINDS }).notNull(),
    rateBp: integer('rate_bp').notNull(),
    /** Input tax may be claimed back. */
    creditable: boolean('creditable').notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    /** Exclusive. */
    effectiveTo: date('effective_to', { mode: 'string' }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('tax_codes_tenant_id_unique').on(t.tenantId, t.id),
    check('tax_codes_kind_check', sql`${t.kind} in ('vat', 'exempt', 'zero', 'reverse_charge')`),
    check('tax_codes_rate_bp_check', sql`${t.rateBp} BETWEEN 0 AND 10000`),
    check('tax_codes_rate_kind_check', sql`(${t.kind} IN ('exempt', 'zero')) = (${t.rateBp} = 0)`),
    check(
      'tax_codes_period_check',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
    check('tax_codes_version_check', sql`${t.version} >= 1`),
  ],
);

/** A payment term (Net 15). Tenant-level: one list for every legal entity. */
export const paymentTerms = appSchema.table(
  'payment_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    netDays: integer('net_days').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t) => [
    unique('payment_terms_tenant_id_unique').on(t.tenantId, t.id),
    unique('payment_terms_tenant_code_unique').on(t.tenantId, t.code),
    check('payment_terms_net_days_check', sql`${t.netDays} BETWEEN 0 AND 365`),
    check('payment_terms_version_check', sql`${t.version} >= 1`),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Entity-owned tables
// ---------------------------------------------------------------------------------------------------------------

/**
 * A quotation: the parent of its versions. Status is derived from `currentVersionId`, never stored. `number`,
 * `opportunityId` and (once set) `customerPartyId` never change (quotations_guard trigger).
 */
export const quotations = appSchema.table(
  'quotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    /** Assigned at creation (C-10), for example QT-2026-0042. */
    number: text('number').notNull(),
    /** The customer party (ADR 0027 section 5). Nullable by the counterparty rule; set at creation. */
    customerPartyId: uuid('customer_party_id'),
    /** Always 'customer' (stored generated), so quotations_customer_party_fk refuses a vendor. Not inserted. */
    customerPartyKind: text('customer_party_kind').generatedAlwaysAs(sql`'customer'`),
    opportunityId: uuid('opportunity_id').notNull(),
    /** Null only between inserting the parent and its first version. Must be one of this quotation's versions. */
    currentVersionId: uuid('current_version_id'),
    ownerUserId: uuid('owner_user_id'),
    /**
     * The opportunity's department, stamped by a trigger on insert and kept in step when the opportunity's
     * department changes (migration 0088), so a `department` grant reaches the quotation.
     */
    departmentId: uuid('department_id'),
    /** 'estimate' for a D3 import only. */
    legacySource: text('legacy_source', { enum: ['estimate'] }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('quotations_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotations_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('quotations_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    foreignKey({
      name: 'quotations_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotations_customer_party_fk',
      columns: [t.tenantId, t.customerPartyId, t.customerPartyKind],
      foreignColumns: [parties.tenantId, parties.id, parties.kind],
    }),
    foreignKey({
      name: 'quotations_customer_fk',
      columns: [t.tenantId, t.customerPartyId],
      foreignColumns: [customers.tenantId, customers.id],
    }),
    foreignKey({
      name: 'quotations_opportunity_fk',
      columns: [t.tenantId, t.organizationId, t.opportunityId],
      foreignColumns: [opportunities.tenantId, opportunities.organizationId, opportunities.id],
    }),
    foreignKey({
      name: 'quotations_owner_user_fk',
      columns: [t.tenantId, t.ownerUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'quotations_department_fk',
      columns: [t.tenantId, t.organizationId, t.departmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    // Added after quotation_versions in the SQL (the two tables reference each other).
    foreignKey({
      name: 'quotations_current_version_fk',
      columns: [t.tenantId, t.organizationId, t.id, t.currentVersionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.quotationId,
        quotationVersions.id,
      ],
    }),
    index('quotations_tenant_customer_party_idx').on(t.tenantId, t.customerPartyId),
    index('quotations_tenant_org_opportunity_idx').on(
      t.tenantId,
      t.organizationId,
      t.opportunityId,
    ),
    index('quotations_tenant_org_department_idx').on(t.tenantId, t.organizationId, t.departmentId),
    check('quotations_legacy_source_check', sql`${t.legacySource} in ('estimate')`),
    check('quotations_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * One numbered version of a quotation. Inserted as draft; once its status is not draft or returned, the columns
 * in QUOTATION_VERSION_MATERIAL_COLUMNS are frozen (quotation_versions_guard trigger). Totals are the server's
 * pricing result in the document currency; `amountNpr` and `nprTaxableAmount` are the NPR snapshot with `fxRate`.
 */
export const quotationVersions = appSchema.table(
  'quotation_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    quotationId: uuid('quotation_id').notNull(),
    /** 1 for the first version. */
    revisionNo: integer('revision_no').notNull(),
    status: text('status', { enum: QUOTATION_STATUSES }).notNull().default('draft'),
    /** Set exactly when status = 'rejected'. */
    rejectionSource: text('rejection_source', { enum: QUOTATION_REJECTION_SOURCES }),
    contactId: uuid('contact_id'),
    /** No FK until the template table exists (plan unit N). */
    templateId: uuid('template_id'),
    currency: char('currency', { length: 3 }).notNull(),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }).notNull(),
    scope: text('scope'),
    assumptions: text('assumptions'),
    exclusions: text('exclusions'),
    /** Free text printed as "Terms and conditions" (0047); frozen with the content once submitted. */
    termsAndConditions: text('terms_and_conditions'),
    deliveryTimeline: text('delivery_timeline'),
    paymentTermId: uuid('payment_term_id'),
    /** The PaymentMilestone array of @bos/contracts. */
    paymentSchedule: jsonb('payment_schedule')
      .notNull()
      .default(sql`'[]'::jsonb`),
    discountMode: text('discount_mode', { enum: QUOTATION_DISCOUNT_MODES }),
    /** The discount as typed: up to four decimal places for a percent, two for an amount. */
    discountInput: numeric('discount_input', { precision: 18, scale: 4 }),
    subtotal: money('subtotal').notNull().default('0'),
    discountAmount: money('discount_amount').notNull().default('0'),
    taxableAmount: money('taxable_amount').notNull().default('0'),
    taxAmount: money('tax_amount').notNull().default('0'),
    total: money('total').notNull().default('0'),
    effectiveDiscountPct: numeric('effective_discount_pct', { precision: 9, scale: 4 })
      .notNull()
      .default('0'),
    /** NPR per unit of `currency`; 1 for NPR. Required from submit on. */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    /** The NPR total. */
    amountNpr: money('amount_npr'),
    /** The NPR taxable amount the approval thresholds compare. */
    nprTaxableAmount: money('npr_taxable_amount'),
    internalCostTotal: money('internal_cost_total'),
    marginPct: numeric('margin_pct', { precision: 9, scale: 4 }),
    calcVersion: integer('calc_version').notNull().default(1),
    /** SHA-256 (32 bytes) of the canonical material fields. */
    contentSha256: bytea('content_sha256'),
    /** SHA-256 (32 bytes) the approval request froze. */
    snapshotSha256: bytea('snapshot_sha256'),
    approvalRequestId: uuid('approval_request_id'),
    renderedDocumentId: uuid('rendered_document_id'),
    renderedSha256: bytea('rendered_sha256'),
    renderState: text('render_state', { enum: QUOTATION_RENDER_STATES }).notNull().default('none'),
    /**
     * Failed renders since the last success or Retry (0115). `failed` below the API's attempt limit waits for its
     * next background try; `failed` at the limit is given up and offers staff a Retry.
     */
    renderAttempts: integer('render_attempts').notNull().default(0),
    /**
     * The DocumentStyleSnapshot of @bos/contracts (layout, colour, company profile, number system), captured by the
     * render job at the first render and never changed after (quotation_versions_document_style_guard, 0046).
     */
    documentStyle: jsonb('document_style'),
    supersedesVersionId: uuid('supersedes_version_id'),
    supersededByVersionId: uuid('superseded_by_version_id'),
    revisionReason: text('revision_reason'),
    cancelReason: text('cancel_reason'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('quotation_versions_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotation_versions_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Target of the current/supersedes/superseded-by FKs: a pointer can only name a version of its quotation.
    unique('quotation_versions_tenant_org_quotation_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.quotationId,
      t.id,
    ),
    unique('quotation_versions_tenant_quotation_revision_unique').on(
      t.tenantId,
      t.quotationId,
      t.revisionNo,
    ),
    foreignKey({
      name: 'quotation_versions_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_versions_quotation_fk',
      columns: [t.tenantId, t.organizationId, t.quotationId],
      foreignColumns: [quotations.tenantId, quotations.organizationId, quotations.id],
    }),
    foreignKey({
      name: 'quotation_versions_contact_fk',
      columns: [t.tenantId, t.contactId],
      foreignColumns: [customerContacts.tenantId, customerContacts.id],
    }),
    foreignKey({
      name: 'quotation_versions_payment_term_fk',
      columns: [t.tenantId, t.paymentTermId],
      foreignColumns: [paymentTerms.tenantId, paymentTerms.id],
    }),
    foreignKey({
      name: 'quotation_versions_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    foreignKey({
      name: 'quotation_versions_rendered_document_fk',
      columns: [t.tenantId, t.organizationId, t.renderedDocumentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'quotation_versions_supersedes_fk',
      columns: [t.tenantId, t.organizationId, t.quotationId, t.supersedesVersionId],
      foreignColumns: [t.tenantId, t.organizationId, t.quotationId, t.id],
    }),
    foreignKey({
      name: 'quotation_versions_superseded_by_fk',
      columns: [t.tenantId, t.organizationId, t.quotationId, t.supersededByVersionId],
      foreignColumns: [t.tenantId, t.organizationId, t.quotationId, t.id],
    }),
    // PostgreSQL has no partial unique constraint, so these are unique indexes.
    uniqueIndex('one_live_version')
      .on(t.tenantId, t.quotationId)
      .where(sql`${t.status} IN ('draft', 'submitted', 'returned', 'approved', 'sent')`),
    uniqueIndex('quotation_versions_one_accepted')
      .on(t.tenantId, t.quotationId)
      .where(sql`${t.status} = 'accepted'`),
    index('quotation_versions_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    check(
      'quotation_versions_status_check',
      sql`${t.status} in ('draft', 'submitted', 'returned', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')`,
    ),
    check(
      'quotation_versions_rejection_source_check',
      sql`${t.rejectionSource} in ('internal', 'customer')`,
    ),
    check(
      'quotation_versions_rejected_check',
      sql`(${t.status} = 'rejected') = (${t.rejectionSource} IS NOT NULL)`,
    ),
    check('quotation_versions_revision_no_check', sql`${t.revisionNo} >= 1`),
    check(
      'quotation_versions_revision_check',
      sql`(${t.revisionNo} = 1) = (${t.supersedesVersionId} IS NULL)`,
    ),
    check(
      'quotation_versions_revision_reason_check',
      sql`${t.revisionNo} = 1 OR ${t.revisionReason} IS NOT NULL`,
    ),
    check(
      'quotation_versions_supersedes_self_check',
      sql`${t.supersedesVersionId} <> ${t.id} AND ${t.supersededByVersionId} <> ${t.id}`,
    ),
    check(
      'quotation_versions_cancel_reason_check',
      sql`${t.status} <> 'cancelled' OR ${t.cancelReason} IS NOT NULL`,
    ),
    check('quotation_versions_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check('quotation_versions_validity_check', sql`${t.validUntil} >= ${t.issueDate}`),
    check(
      'quotation_versions_payment_schedule_check',
      sql`jsonb_typeof(${t.paymentSchedule}) = 'array'`,
    ),
    check('quotation_versions_discount_mode_check', sql`${t.discountMode} in ('pct', 'amount')`),
    check(
      'quotation_versions_discount_input_check',
      sql`(${t.discountMode} IS NULL) = (${t.discountInput} IS NULL) AND ${t.discountInput} >= 0 AND (${t.discountMode} <> 'pct' OR ${t.discountInput} <= 100)`,
    ),
    check(
      'quotation_versions_amount_discount_precision_check',
      sql`${t.discountMode} <> 'amount' OR ${t.discountInput} = round(${t.discountInput}, 2)`,
    ),
    check(
      'quotation_versions_amounts_check',
      sql`${t.subtotal} >= 0 AND ${t.discountAmount} >= 0 AND ${t.discountAmount} <= ${t.subtotal} AND ${t.taxAmount} >= 0`,
    ),
    check(
      'quotation_versions_taxable_check',
      sql`${t.taxableAmount} = ${t.subtotal} - ${t.discountAmount}`,
    ),
    check('quotation_versions_total_check', sql`${t.total} = ${t.taxableAmount} + ${t.taxAmount}`),
    check(
      'quotation_versions_effective_discount_check',
      sql`${t.effectiveDiscountPct} BETWEEN 0 AND 100`,
    ),
    check(
      'quotation_versions_fx_rate_check',
      sql`${t.fxRate} > 0 AND (${t.currency} <> 'NPR' OR ${t.fxRate} = 1)`,
    ),
    check(
      'quotation_versions_fx_source_check',
      sql`(${t.fxSource} IS NULL) = (${t.fxDate} IS NULL)`,
    ),
    check(
      'quotation_versions_npr_amounts_check',
      sql`${t.amountNpr} >= 0 AND ${t.nprTaxableAmount} >= 0`,
    ),
    check('quotation_versions_internal_cost_check', sql`${t.internalCostTotal} >= 0`),
    check('quotation_versions_calc_version_check', sql`${t.calcVersion} >= 1`),
    check(
      'quotation_versions_sha256_check',
      sql`octet_length(${t.contentSha256}) = 32 AND octet_length(${t.snapshotSha256}) = 32 AND octet_length(${t.renderedSha256}) = 32`,
    ),
    check(
      'quotation_versions_snapshot_check',
      sql`${t.status} IN ('draft', 'returned', 'cancelled') OR (${t.fxRate} IS NOT NULL AND ${t.amountNpr} IS NOT NULL AND ${t.nprTaxableAmount} IS NOT NULL AND ${t.contentSha256} IS NOT NULL AND ${t.snapshotSha256} IS NOT NULL AND (${t.currency} = 'NPR' OR ${t.fxSource} IS NOT NULL))`,
    ),
    check(
      'quotation_versions_render_state_check',
      sql`${t.renderState} in ('none', 'pending', 'rendered', 'failed')`,
    ),
    check('quotation_versions_render_attempts_check', sql`${t.renderAttempts} >= 0`),
    check(
      'quotation_versions_rendered_check',
      sql`${t.renderState} <> 'rendered' OR (${t.renderedDocumentId} IS NOT NULL AND ${t.renderedSha256} IS NOT NULL)`,
    ),
    check(
      'quotation_versions_document_style_check',
      sql`${t.documentStyle} IS NULL OR jsonb_typeof(${t.documentStyle}) = 'object'`,
    ),
    check('quotation_versions_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * One line of a version. No per-line discount: `discountAlloc` is the line's share of the quotation discount.
 * gross = round(quantity * unitPrice, 2) and taxable = gross - discountAlloc (CHECKs). Frozen with its version.
 */
export const quotationLines = appSchema.table(
  'quotation_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    versionId: uuid('version_id').notNull(),
    lineNo: integer('line_no').notNull(),
    /** No FK until a catalogue table exists. */
    catalogItemId: uuid('catalog_item_id'),
    description: text('description').notNull(),
    uom: text('uom').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 4 }).notNull(),
    unitPrice: money('unit_price').notNull(),
    /** Internal; never reaches the customer. */
    unitCost: money('unit_cost'),
    taxCodeId: uuid('tax_code_id').notNull(),
    gross: money('gross').notNull(),
    discountAlloc: money('discount_alloc').notNull().default('0'),
    taxable: money('taxable').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('quotation_lines_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotation_lines_tenant_version_line_no_unique').on(t.tenantId, t.versionId, t.lineNo),
    foreignKey({
      name: 'quotation_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_lines_version_fk',
      columns: [t.tenantId, t.organizationId, t.versionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'quotation_lines_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    index('quotation_lines_tenant_tax_code_idx').on(t.tenantId, t.taxCodeId),
    check('quotation_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('quotation_lines_quantity_check', sql`${t.quantity} > 0`),
    check('quotation_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check('quotation_lines_unit_cost_check', sql`${t.unitCost} >= 0`),
    check(
      'quotation_lines_gross_check',
      sql`${t.gross} = round(${t.quantity} * ${t.unitPrice}, 2)`,
    ),
    check(
      'quotation_lines_discount_alloc_check',
      sql`${t.discountAlloc} >= 0 AND ${t.discountAlloc} <= ${t.gross}`,
    ),
    check('quotation_lines_taxable_check', sql`${t.taxable} = ${t.gross} - ${t.discountAlloc}`),
  ],
);

/** Tax per tax code, rounded once per code. `label` and `rate` (percent) are copied from the tax code. */
export const quotationTaxSummary = appSchema.table(
  'quotation_tax_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    versionId: uuid('version_id').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    label: text('label').notNull(),
    rate: numeric('rate', { precision: 7, scale: 4 }).notNull(),
    base: money('base').notNull(),
    tax: money('tax').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quotation_tax_summary_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotation_tax_summary_tenant_version_tax_code_unique').on(
      t.tenantId,
      t.versionId,
      t.taxCodeId,
    ),
    foreignKey({
      name: 'quotation_tax_summary_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_tax_summary_version_fk',
      columns: [t.tenantId, t.organizationId, t.versionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'quotation_tax_summary_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    check('quotation_tax_summary_rate_check', sql`${t.rate} BETWEEN 0 AND 100`),
    check('quotation_tax_summary_amounts_check', sql`${t.base} >= 0 AND ${t.tax} >= 0`),
  ],
);

/** Everyone who saved a material field of a version (A2 C6). Frozen with the version. */
export const quotationVersionEditors = appSchema.table(
  'quotation_version_editors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    versionId: uuid('version_id').notNull(),
    userId: uuid('user_id').notNull(),
    firstEditAt: timestamp('first_edit_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quotation_version_editors_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotation_version_editors_tenant_version_user_unique').on(
      t.tenantId,
      t.versionId,
      t.userId,
    ),
    foreignKey({
      name: 'quotation_version_editors_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_version_editors_version_fk',
      columns: [t.tenantId, t.organizationId, t.versionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'quotation_version_editors_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
  ],
);

/**
 * The customer's answer to a sent version, one per version. Append-only. Accepting needs at least one evidence
 * kind; rejecting needs a comment. `actorId` is an app.users row (staff, or a portal user later).
 * Migration 0018 added `acceptedByName` and `evidenceDocumentIds`.
 */
export const quotationAcceptances = appSchema.table(
  'quotation_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    versionId: uuid('version_id').notNull(),
    outcome: text('outcome', { enum: QUOTATION_ACCEPTANCE_OUTCOMES }).notNull(),
    actorKind: text('actor_kind', { enum: QUOTATION_ACTOR_KINDS }).notNull(),
    actorId: uuid('actor_id').notNull(),
    decidedOn: date('decided_on', { mode: 'string' }).notNull(),
    comment: text('comment'),
    evidenceKinds: text('evidence_kinds', { enum: QUOTATION_EVIDENCE_KINDS })
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The name the customer signed with (migration 0018); at most 200 characters. */
    acceptedByName: text('accepted_by_name'),
    /** Kernel document ids of the uploaded evidence files (migration 0018). No FK: an array cannot have one. */
    evidenceDocumentIds: uuid('evidence_document_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quotation_acceptances_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotation_acceptances_tenant_version_unique').on(t.tenantId, t.versionId),
    foreignKey({
      name: 'quotation_acceptances_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_acceptances_version_fk',
      columns: [t.tenantId, t.organizationId, t.versionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'quotation_acceptances_actor_user_fk',
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('quotation_acceptances_outcome_check', sql`${t.outcome} in ('accepted', 'rejected')`),
    check(
      'quotation_acceptances_actor_kind_check',
      sql`${t.actorKind} in ('staff', 'customer_user')`,
    ),
    check(
      'quotation_acceptances_evidence_kinds_check',
      sql`${t.evidenceKinds} <@ ARRAY['contract', 'purchase_order', 'signed_quote']::text[] AND array_position(${t.evidenceKinds}, NULL) IS NULL`,
    ),
    check(
      'quotation_acceptances_accepted_evidence_check',
      sql`${t.outcome} <> 'accepted' OR cardinality(${t.evidenceKinds}) >= 1`,
    ),
    check(
      'quotation_acceptances_rejected_comment_check',
      sql`${t.outcome} <> 'rejected' OR ${t.comment} IS NOT NULL`,
    ),
    check(
      'quotation_acceptances_accepted_by_name_check',
      sql`${t.acceptedByName} IS NULL OR char_length(${t.acceptedByName}) <= 200`,
    ),
    check(
      'quotation_acceptances_evidence_document_ids_check',
      sql`array_position(${t.evidenceDocumentIds}, NULL) IS NULL`,
    ),
  ],
);

/**
 * Staff confirm the evidence behind a customer's portal acceptance (migration 0107, F1-Q28): the kinds they hold,
 * the files and a note. One row per accepted version, append-only. An acceptance staff recorded themselves needs
 * none (it met the policy when recorded).
 */
export const quotationEvidenceConfirmations = appSchema.table(
  'quotation_evidence_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    versionId: uuid('version_id').notNull(),
    evidenceKinds: text('evidence_kinds', { enum: QUOTATION_EVIDENCE_KINDS }).array().notNull(),
    evidenceDocumentIds: uuid('evidence_document_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    comment: text('comment'),
    confirmedBy: uuid('confirmed_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quotation_evidence_confirmations_tenant_id_unique').on(t.tenantId, t.id),
    unique('quotation_evidence_confirmations_tenant_version_unique').on(t.tenantId, t.versionId),
    foreignKey({
      name: 'quotation_evidence_confirmations_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_evidence_confirmations_version_fk',
      columns: [t.tenantId, t.organizationId, t.versionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'quotation_evidence_confirmations_confirmed_by_user_fk',
      columns: [t.tenantId, t.confirmedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'quotation_evidence_confirmations_evidence_kinds_check',
      sql`${t.evidenceKinds} <@ ARRAY['contract', 'purchase_order', 'signed_quote']::text[] AND array_position(${t.evidenceKinds}, NULL) IS NULL AND cardinality(${t.evidenceKinds}) >= 1`,
    ),
    check(
      'quotation_evidence_confirmations_evidence_document_ids_check',
      sql`array_position(${t.evidenceDocumentIds}, NULL) IS NULL`,
    ),
    check(
      'quotation_evidence_confirmations_comment_check',
      sql`${t.comment} IS NULL OR char_length(${t.comment}) <= 2000`,
    ),
  ],
);
/** Every status change of a version. Append-only. `actorId` null = the system. */
export const quotationStatusHistory = appSchema.table(
  'quotation_status_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    organizationId: uuid('organization_id').notNull(),
    versionId: uuid('version_id').notNull(),
    fromStatus: text('from_status', { enum: QUOTATION_STATUSES }),
    toStatus: text('to_status', { enum: QUOTATION_STATUSES }).notNull(),
    actorId: uuid('actor_id'),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('quotation_status_history_tenant_id_unique').on(t.tenantId, t.id),
    foreignKey({
      name: 'quotation_status_history_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'quotation_status_history_version_fk',
      columns: [t.tenantId, t.organizationId, t.versionId],
      foreignColumns: [
        quotationVersions.tenantId,
        quotationVersions.organizationId,
        quotationVersions.id,
      ],
    }),
    foreignKey({
      name: 'quotation_status_history_actor_user_fk',
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('quotation_status_history_tenant_org_version_at_idx').on(
      t.tenantId,
      t.organizationId,
      t.versionId,
      t.at,
    ),
    check(
      'quotation_status_history_from_status_check',
      sql`${t.fromStatus} in ('draft', 'submitted', 'returned', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')`,
    ),
    check(
      'quotation_status_history_to_status_check',
      sql`${t.toStatus} in ('draft', 'submitted', 'returned', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded')`,
    ),
  ],
);
