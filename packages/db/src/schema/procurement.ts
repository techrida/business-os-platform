// Drizzle tables for migration 0033_procurement_sourcing: the sourcing half of P4 (purchase requests and their
// lines, RFQs and the vendors invited to them, vendor quotations and their lines, the portal inbox of uploaded
// quotations, and the comparison scores). Money is numeric(18,2), quantities numeric(18,4) and FX rates
// numeric(18,6), read as strings; wrap them in decimal.js, never Number().
// The SQL in migrations/0033_procurement_sourcing.sql is the source of truth; this file only types the queries, so
// keep the two in step (a change is a new migration, never an edit of an old one). procurement-schema.test.ts
// compares their names. All eight tables are entity-owned: a FK into another entity-owned table is
// (tenant_id, organization_id, x), a FK into a tenant-level table (users, tax_codes) is (tenant_id, x).
// Not modelled here: the trigger purchase_request_lines_guard (it freezes the lines once the request leaves draft or
// returned). purchase_requests.project_id has no FK (no project table yet).
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from './approvals.js';
import { costCenters } from './cost-centers.js';
import { documents } from './documents.js';
import { departments, users } from './identity.js';
import { appSchema, organizations, tenants } from './platform.js';
import { taxCodes } from './quotations.js';
import { vendorAccounts } from './vendors.js';

// These mirror the catalogues in @bos/contracts (procurement.ts); the db package does not depend on contracts.
export const PURCHASE_REQUEST_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'dept_approved',
  'sourcing',
  'commitment_pending',
  'approved',
  'po_issued',
  'closed',
  'rejected',
  'cancelled',
] as const;
/** The statuses in which a request, and so its lines, may still be edited (purchase_request_lines_guard). */
export const PURCHASE_REQUEST_EDITABLE_STATUSES = ['draft', 'returned'] as const;
export const PURCHASE_REQUEST_TYPES = ['goods', 'service', 'mixed'] as const;
export const RFQ_STATUSES = ['open', 'closed', 'recommended', 'cancelled'] as const;
export const QUOTATION_SUBMISSION_STATUSES = [
  'received',
  'converted',
  'rejected',
  'withdrawn',
] as const;

const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
const quantity = (name: string) => numeric(name, { precision: 18, scale: 4 });
const fxRate = (name: string) => numeric(name, { precision: 18, scale: 6 });

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

const tenantColumn = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

// ---------------------------------------------------------------------------------------------------------------
// Purchase requests
// ---------------------------------------------------------------------------------------------------------------

/**
 * A purchase request. `number` is the service's (the draft reference), so it may be NULL for a draft; it is unique
 * per entity once set. The estimate carries its FX snapshot, required from submit on (snapshot_check).
 */
export const purchaseRequests = appSchema.table(
  'purchase_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    number: text('number'),
    requestType: text('request_type', { enum: PURCHASE_REQUEST_TYPES }).notNull(),
    departmentId: uuid('department_id').notNull(),
    requesterUserId: uuid('requester_user_id').notNull(),
    costCenterId: uuid('cost_center_id').notNull(),
    justification: text('justification').notNull(),
    requiredBy: date('required_by', { mode: 'string' }).notNull(),
    deliveryLocation: text('delivery_location'),
    budgetCode: text('budget_code').notNull(),
    /** No FK: there is no project table yet. */
    projectId: uuid('project_id'),
    currency: char('currency', { length: 3 }).notNull().default('NPR'),
    /** The sum of the lines' `estimatedAmount` (the service sums; a CHECK cannot). */
    estimatedTotal: money('estimated_total').notNull().default('0'),
    /** NPR per unit (1 for NPR). */
    fxRate: fxRate('fx_rate'),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    estimatedTotalNpr: money('estimated_total_npr'),
    /** An emergency request names its reason (emergency_reason_check) and adds a Management step (AD12). */
    isEmergency: boolean('is_emergency').notNull().default(false),
    emergencyReason: text('emergency_reason'),
    status: text('status', { enum: PURCHASE_REQUEST_STATUSES }).notNull().default('draft'),
    approvalRequestId: uuid('approval_request_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('purchase_requests_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('purchase_requests_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    foreignKey({
      name: 'purchase_requests_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'purchase_requests_department_fk',
      columns: [t.tenantId, t.organizationId, t.departmentId],
      foreignColumns: [departments.tenantId, departments.organizationId, departments.id],
    }),
    foreignKey({
      name: 'purchase_requests_cost_center_fk',
      columns: [t.tenantId, t.organizationId, t.costCenterId],
      foreignColumns: [costCenters.tenantId, costCenters.organizationId, costCenters.id],
    }),
    foreignKey({
      name: 'purchase_requests_requester_user_fk',
      columns: [t.tenantId, t.requesterUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'purchase_requests_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    index('purchase_requests_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    index('purchase_requests_tenant_requester_idx').on(t.tenantId, t.requesterUserId),
    check(
      'purchase_requests_request_type_check',
      sql`${t.requestType} in ('goods', 'service', 'mixed')`,
    ),
    check(
      'purchase_requests_status_check',
      sql`${t.status} in ('draft', 'submitted', 'returned', 'dept_approved', 'sourcing', 'commitment_pending', 'approved', 'po_issued', 'closed', 'rejected', 'cancelled')`,
    ),
    check('purchase_requests_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check(
      'purchase_requests_emergency_reason_check',
      sql`${t.isEmergency} = false OR (${t.emergencyReason} IS NOT NULL AND btrim(${t.emergencyReason}) <> '')`,
    ),
    check(
      'purchase_requests_estimated_total_check',
      sql`${t.estimatedTotal} >= 0 AND ${t.estimatedTotalNpr} >= 0`,
    ),
    check('purchase_requests_fx_rate_check', sql`${t.fxRate} > 0`),
    check(
      'purchase_requests_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR ${t.fxRate} IS NULL OR (${t.fxRate} = 1 AND ${t.estimatedTotalNpr} = ${t.estimatedTotal})`,
    ),
    check(
      'purchase_requests_fx_source_check',
      sql`${t.currency} = 'NPR' OR ${t.fxRate} IS NULL OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check(
      'purchase_requests_snapshot_check',
      sql`${t.status} IN ('draft', 'returned', 'cancelled') OR (${t.fxRate} IS NOT NULL AND ${t.estimatedTotalNpr} IS NOT NULL)`,
    ),
    check('purchase_requests_version_check', sql`${t.version} >= 1`),
  ],
);

/** One line of a request, frozen with it once it leaves draft or returned. */
export const purchaseRequestLines = appSchema.table(
  'purchase_request_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    purchaseRequestId: uuid('purchase_request_id').notNull(),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    specification: text('specification'),
    requiresSerials: boolean('requires_serials').notNull().default(false),
    uom: text('uom').notNull(),
    quantity: quantity('quantity').notNull(),
    estimatedUnitPrice: money('estimated_unit_price').notNull(),
    /** round(quantity * estimatedUnitPrice, 2) (CHECK). */
    estimatedAmount: money('estimated_amount').notNull(),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('purchase_request_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent key of vendor_quotation_lines: a quotation line prices a line of the RFQ's own request.
    unique('purchase_request_lines_tenant_org_pr_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseRequestId,
      t.id,
    ),
    unique('purchase_request_lines_tenant_pr_line_no_unique').on(
      t.tenantId,
      t.purchaseRequestId,
      t.lineNo,
    ),
    foreignKey({
      name: 'purchase_request_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'purchase_request_lines_purchase_request_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId],
      foreignColumns: [
        purchaseRequests.tenantId,
        purchaseRequests.organizationId,
        purchaseRequests.id,
      ],
    }),
    check('purchase_request_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('purchase_request_lines_quantity_check', sql`${t.quantity} > 0`),
    check('purchase_request_lines_unit_price_check', sql`${t.estimatedUnitPrice} >= 0`),
    check(
      'purchase_request_lines_amount_check',
      sql`${t.estimatedAmount} = round(${t.quantity} * ${t.estimatedUnitPrice}, 2)`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// RFQs
// ---------------------------------------------------------------------------------------------------------------

/** An RFQ for one request; at most one per request is live (not cancelled). */
export const rfqs = appSchema.table(
  'rfqs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    purchaseRequestId: uuid('purchase_request_id').notNull(),
    number: text('number').notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    status: text('status', { enum: RFQ_STATUSES }).notNull().default('open'),
    /** One of this RFQ's own quotations (rfqs_recommended_quotation_fk, added after vendor_quotations). */
    recommendedQuotationId: uuid('recommended_quotation_id'),
    /** AD13: required by the service when fewer quotes than `procurement.min_quotes` were received. */
    fewerThanThreeReason: text('fewer_than_three_reason'),
    recommendationRationale: text('recommendation_rationale'),
    commitmentApprovalRequestId: uuid('commitment_approval_request_id'),
    createdBy: uuid('created_by').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('rfqs_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('rfqs_tenant_org_pr_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseRequestId,
      t.id,
    ),
    unique('rfqs_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    foreignKey({
      name: 'rfqs_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'rfqs_purchase_request_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId],
      foreignColumns: [
        purchaseRequests.tenantId,
        purchaseRequests.organizationId,
        purchaseRequests.id,
      ],
    }),
    foreignKey({
      name: 'rfqs_commitment_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.commitmentApprovalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    foreignKey({
      name: 'rfqs_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    // Added after vendor_quotations in the SQL (the two tables reference each other).
    foreignKey({
      name: 'rfqs_recommended_quotation_fk',
      columns: [t.tenantId, t.organizationId, t.id, t.recommendedQuotationId],
      foreignColumns: [
        vendorQuotations.tenantId,
        vendorQuotations.organizationId,
        vendorQuotations.rfqId,
        vendorQuotations.id,
      ],
    }),
    // PostgreSQL has no partial unique constraint, so this is a unique index.
    uniqueIndex('rfqs_tenant_purchase_request_live_unique')
      .on(t.tenantId, t.purchaseRequestId)
      .where(sql`${t.status} <> 'cancelled'`),
    index('rfqs_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    check('rfqs_status_check', sql`${t.status} in ('open', 'closed', 'recommended', 'cancelled')`),
    check(
      'rfqs_recommended_check',
      sql`${t.status} <> 'recommended' OR (${t.recommendedQuotationId} IS NOT NULL AND ${t.recommendationRationale} IS NOT NULL)`,
    ),
    check('rfqs_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * A vendor invited to an RFQ. The vendor must have a vendor account in the RFQ's entity (rfq_vendors_vendor_account_fk
 * runs through vendor_accounts' (tenant_id, organization_id, vendor_id) key).
 */
export const rfqVendors = appSchema.table(
  'rfq_vendors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    rfqId: uuid('rfq_id').notNull(),
    vendorId: uuid('vendor_id').notNull(),
    invitedBy: uuid('invited_by').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('rfq_vendors_tenant_org_rfq_vendor_unique').on(
      t.tenantId,
      t.organizationId,
      t.rfqId,
      t.vendorId,
    ),
    foreignKey({
      name: 'rfq_vendors_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'rfq_vendors_rfq_fk',
      columns: [t.tenantId, t.organizationId, t.rfqId],
      foreignColumns: [rfqs.tenantId, rfqs.organizationId, rfqs.id],
    }),
    foreignKey({
      name: 'rfq_vendors_vendor_account_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId],
      foreignColumns: [
        vendorAccounts.tenantId,
        vendorAccounts.organizationId,
        vendorAccounts.vendorId,
      ],
    }),
    foreignKey({
      name: 'rfq_vendors_invited_by_fk',
      columns: [t.tenantId, t.invitedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('rfq_vendors_tenant_org_vendor_idx').on(t.tenantId, t.organizationId, t.vendorId),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Vendor quotations
// ---------------------------------------------------------------------------------------------------------------

/**
 * A quotation of an invited vendor, one per vendor per RFQ. `purchaseRequestId` must be the RFQ's own (the FK
 * to rfqs runs through it). `totalNpr` is the NPR snapshot of `total` at `fxRate`.
 */
export const vendorQuotations = appSchema.table(
  'vendor_quotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    rfqId: uuid('rfq_id').notNull(),
    purchaseRequestId: uuid('purchase_request_id').notNull(),
    vendorId: uuid('vendor_id').notNull(),
    vendorRef: text('vendor_ref'),
    validUntil: date('valid_until', { mode: 'string' }),
    currency: char('currency', { length: 3 }).notNull(),
    subtotal: money('subtotal').notNull(),
    taxAmount: money('tax_amount').notNull(),
    /** subtotal + taxAmount (CHECK). */
    total: money('total').notNull(),
    /** NPR per unit (1 for NPR, with total_npr = total). */
    fxRate: fxRate('fx_rate').notNull(),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    totalNpr: money('total_npr').notNull(),
    deliveryDays: integer('delivery_days'),
    warranty: text('warranty'),
    terms: text('terms'),
    /** The vendor's quotation file: a kernel document of the same entity. */
    documentId: uuid('document_id').notNull(),
    recordedBy: uuid('recorded_by').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_quotations_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent keys of rfqs.recommended_quotation_id, vendor_quotation_lines and the inbox.
    unique('vendor_quotations_tenant_org_rfq_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.rfqId,
      t.id,
    ),
    unique('vendor_quotations_tenant_org_pr_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseRequestId,
      t.id,
    ),
    unique('vendor_quotations_tenant_org_vendor_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.vendorId,
      t.id,
    ),
    unique('vendor_quotations_tenant_org_rfq_vendor_unique').on(
      t.tenantId,
      t.organizationId,
      t.rfqId,
      t.vendorId,
    ),
    foreignKey({
      name: 'vendor_quotations_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_quotations_rfq_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId, t.rfqId],
      foreignColumns: [rfqs.tenantId, rfqs.organizationId, rfqs.purchaseRequestId, rfqs.id],
    }),
    foreignKey({
      name: 'vendor_quotations_rfq_vendor_fk',
      columns: [t.tenantId, t.organizationId, t.rfqId, t.vendorId],
      foreignColumns: [
        rfqVendors.tenantId,
        rfqVendors.organizationId,
        rfqVendors.rfqId,
        rfqVendors.vendorId,
      ],
    }),
    foreignKey({
      name: 'vendor_quotations_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'vendor_quotations_recorded_by_fk',
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('vendor_quotations_tenant_org_vendor_idx').on(t.tenantId, t.organizationId, t.vendorId),
    check('vendor_quotations_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check(
      'vendor_quotations_amounts_check',
      sql`${t.subtotal} >= 0 AND ${t.taxAmount} >= 0 AND ${t.totalNpr} >= 0`,
    ),
    check('vendor_quotations_total_check', sql`${t.total} = ${t.subtotal} + ${t.taxAmount}`),
    check('vendor_quotations_fx_rate_check', sql`${t.fxRate} > 0`),
    check(
      'vendor_quotations_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR (${t.fxRate} = 1 AND ${t.totalNpr} = ${t.total})`,
    ),
    check(
      'vendor_quotations_fx_source_check',
      sql`${t.currency} = 'NPR' OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check('vendor_quotations_delivery_days_check', sql`${t.deliveryDays} >= 0`),
    check('vendor_quotations_version_check', sql`${t.version} >= 1`),
  ],
);

/** What a vendor quoted for one line of the request, with the tax code of the line. */
export const vendorQuotationLines = appSchema.table(
  'vendor_quotation_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorQuotationId: uuid('vendor_quotation_id').notNull(),
    /** The request of the quotation's RFQ; both FKs below run through it. */
    purchaseRequestId: uuid('purchase_request_id').notNull(),
    prLineId: uuid('pr_line_id').notNull(),
    /** What the line quotes; defaults to the request line's description when recorded. */
    description: text('description').notNull(),
    quantity: quantity('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    /** round(quantity * unitPrice, 2) (CHECK). */
    gross: money('gross').notNull(),
    taxAmount: money('tax_amount').notNull(),
    /** gross + taxAmount (CHECK). */
    lineTotal: money('line_total').notNull(),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_quotation_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    unique('vendor_quotation_lines_tenant_quotation_pr_line_unique').on(
      t.tenantId,
      t.vendorQuotationId,
      t.prLineId,
    ),
    foreignKey({
      name: 'vendor_quotation_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_quotation_lines_quotation_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId, t.vendorQuotationId],
      foreignColumns: [
        vendorQuotations.tenantId,
        vendorQuotations.organizationId,
        vendorQuotations.purchaseRequestId,
        vendorQuotations.id,
      ],
    }),
    foreignKey({
      name: 'vendor_quotation_lines_pr_line_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId, t.prLineId],
      foreignColumns: [
        purchaseRequestLines.tenantId,
        purchaseRequestLines.organizationId,
        purchaseRequestLines.purchaseRequestId,
        purchaseRequestLines.id,
      ],
    }),
    foreignKey({
      name: 'vendor_quotation_lines_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    index('vendor_quotation_lines_tenant_tax_code_idx').on(t.tenantId, t.taxCodeId),
    check('vendor_quotation_lines_description_check', sql`btrim(${t.description}) <> ''`),
    check('vendor_quotation_lines_quantity_check', sql`${t.quantity} > 0`),
    check('vendor_quotation_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check(
      'vendor_quotation_lines_gross_check',
      sql`${t.gross} = round(${t.quantity} * ${t.unitPrice}, 2)`,
    ),
    check('vendor_quotation_lines_tax_amount_check', sql`${t.taxAmount} >= 0`),
    check(
      'vendor_quotation_lines_line_total_check',
      sql`${t.lineTotal} = ${t.gross} + ${t.taxAmount}`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// The portal inbox and the comparison
// ---------------------------------------------------------------------------------------------------------------

/**
 * A quotation a vendor uploaded, waiting for Procurement to convert or reject it. It never posts anything. `rfqId`
 * is NULL for an upload that names no RFQ (then the FK to rfq_vendors is not checked).
 */
export const vendorQuotationSubmissions = appSchema.table(
  'vendor_quotation_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorId: uuid('vendor_id').notNull(),
    rfqId: uuid('rfq_id'),
    /** The vendor's portal user. */
    submittedBy: uuid('submitted_by').notNull(),
    documentId: uuid('document_id').notNull(),
    vendorRef: text('vendor_ref'),
    note: text('note'),
    status: text('status', { enum: QUOTATION_SUBMISSION_STATUSES }).notNull().default('received'),
    /** Set exactly when the status is 'converted' (CHECK); the quotation must be the same vendor's. */
    convertedQuotationId: uuid('converted_quotation_id'),
    rejectionReason: text('rejection_reason'),
    /** The staff reviewer; required once converted or rejected. */
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_quotation_submissions_tenant_org_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.id,
    ),
    foreignKey({
      name: 'vendor_quotation_submissions_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_quotation_submissions_vendor_account_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId],
      foreignColumns: [
        vendorAccounts.tenantId,
        vendorAccounts.organizationId,
        vendorAccounts.vendorId,
      ],
    }),
    foreignKey({
      name: 'vendor_quotation_submissions_rfq_vendor_fk',
      columns: [t.tenantId, t.organizationId, t.rfqId, t.vendorId],
      foreignColumns: [
        rfqVendors.tenantId,
        rfqVendors.organizationId,
        rfqVendors.rfqId,
        rfqVendors.vendorId,
      ],
    }),
    foreignKey({
      name: 'vendor_quotation_submissions_submitted_by_fk',
      columns: [t.tenantId, t.submittedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'vendor_quotation_submissions_document_fk',
      columns: [t.tenantId, t.organizationId, t.documentId],
      foreignColumns: [documents.tenantId, documents.organizationId, documents.id],
    }),
    foreignKey({
      name: 'vendor_quotation_submissions_converted_quotation_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId, t.convertedQuotationId],
      foreignColumns: [
        vendorQuotations.tenantId,
        vendorQuotations.organizationId,
        vendorQuotations.vendorId,
        vendorQuotations.id,
      ],
    }),
    foreignKey({
      name: 'vendor_quotation_submissions_reviewed_by_fk',
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('vendor_quotation_submissions_tenant_org_status_idx').on(
      t.tenantId,
      t.organizationId,
      t.status,
    ),
    index('vendor_quotation_submissions_tenant_org_vendor_idx').on(
      t.tenantId,
      t.organizationId,
      t.vendorId,
    ),
    check(
      'vendor_quotation_submissions_status_check',
      sql`${t.status} in ('received', 'converted', 'rejected', 'withdrawn')`,
    ),
    check(
      'vendor_quotation_submissions_converted_check',
      sql`(${t.status} = 'converted') = (${t.convertedQuotationId} IS NOT NULL)`,
    ),
    check(
      'vendor_quotation_submissions_rejected_check',
      sql`${t.status} <> 'rejected' OR (${t.rejectionReason} IS NOT NULL AND btrim(${t.rejectionReason}) <> '')`,
    ),
    check(
      'vendor_quotation_submissions_reviewed_check',
      sql`${t.status} NOT IN ('converted', 'rejected') OR ${t.reviewedBy} IS NOT NULL`,
    ),
    check('vendor_quotation_submissions_version_check', sql`${t.version} >= 1`),
  ],
);

/** One internal score (0 to 100) of one criterion of a quotation. Never in a portal view. */
export const vendorComparisonScores = appSchema.table(
  'vendor_comparison_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    vendorQuotationId: uuid('vendor_quotation_id').notNull(),
    criterion: text('criterion').notNull(),
    score: numeric('score', { precision: 5, scale: 2 }).notNull(),
    comment: text('comment'),
    scoredBy: uuid('scored_by').notNull(),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('vendor_comparison_scores_tenant_quotation_criterion_unique').on(
      t.tenantId,
      t.vendorQuotationId,
      t.criterion,
    ),
    foreignKey({
      name: 'vendor_comparison_scores_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'vendor_comparison_scores_quotation_fk',
      columns: [t.tenantId, t.organizationId, t.vendorQuotationId],
      foreignColumns: [
        vendorQuotations.tenantId,
        vendorQuotations.organizationId,
        vendorQuotations.id,
      ],
    }),
    foreignKey({
      name: 'vendor_comparison_scores_scored_by_fk',
      columns: [t.tenantId, t.scoredBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('vendor_comparison_scores_criterion_check', sql`btrim(${t.criterion}) <> ''`),
    check('vendor_comparison_scores_score_check', sql`${t.score} BETWEEN 0 AND 100`),
  ],
);
