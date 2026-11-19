// Drizzle tables for migration 0034_procurement_orders: the order and receipt half of P4 (purchase orders, their
// immutable versions and their lines; goods receipts and service confirmations with their lines; the serial numbers a
// goods line took in). Money is numeric(18,2), quantities numeric(18,4) and FX rates numeric(18,6), read as strings;
// wrap them in decimal.js, never Number().
// The SQL in migrations/0034_procurement_orders.sql is the source of truth; this file only types the queries, so
// keep the two in step (a change is a new migration, never an edit of an old one). procurement-orders-schema.test.ts
// compares their names. All six tables are entity-owned: a FK into another entity-owned table is
// (tenant_id, organization_id, x), a FK into a tenant-level table (users, tax_codes) is (tenant_id, x).
// Not modelled here: the triggers purchase_order_versions_immutable (a version is never updated or deleted; bos_app
// has no UPDATE or DELETE privilege either), receipt_lines_guard (the over-receipt and full-reversal rules, and no DELETE of a reversal line) and
// purchase_order_lines_open_guard (ordered - cancelled may not shrink below what was received).
// receipt_lines.over_receipt_exception_id has no FK (no exceptions table yet).
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
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
import { users } from './identity.js';
import { appSchema, organizations, tenants } from './platform.js';
import { purchaseRequestLines, purchaseRequests, rfqs, vendorQuotations } from './procurement.js';
import { taxCodes } from './quotations.js';
import { vendorAccounts } from './vendors.js';

// These mirror the catalogues in @bos/contracts (procurement.ts); the db package does not depend on contracts.
export const PO_STATUSES = [
  'draft',
  'issued',
  'partially_received',
  'fully_received',
  'amendment_pending',
  'closed',
  'short_closed',
  'cancelled',
] as const;
/** The approval band a PO was committed in (AD4); an amendment needs re-approval only if the band rises (AD7). */
export const PO_APPROVED_BANDS = ['base', 'management', 'founder'] as const;
export const PO_LINE_KINDS = ['goods', 'service'] as const;
export const RECEIPT_STATUSES = ['draft', 'confirmed', 'reversed', 'discarded'] as const;
export const RECEIPT_KINDS = ['goods', 'service'] as const;

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
// Purchase orders
// ---------------------------------------------------------------------------------------------------------------

/**
 * A purchase order for a vendor with an account in the same entity. `rfqId` and `vendorQuotationId` are both set or
 * both NULL; when set they are the request's own RFQ, that RFQ's own quotation and the vendor's own quotation.
 * `currentVersion` is 0 while a draft; an issued PO has an issue stamp and version >= 1 (issued_check).
 */
export const purchaseOrders = appSchema.table(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    /** From NumberingService, with its sequence and fiscal year. */
    number: text('number').notNull(),
    numberSeq: integer('number_seq').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    purchaseRequestId: uuid('purchase_request_id').notNull(),
    rfqId: uuid('rfq_id'),
    vendorQuotationId: uuid('vendor_quotation_id'),
    vendorId: uuid('vendor_id').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status', { enum: PO_STATUSES }).notNull().default('draft'),
    paymentTermsDays: integer('payment_terms_days').notNull(),
    advancePercent: numeric('advance_percent', { precision: 7, scale: 4 }).notNull().default('0'),
    /** The total the commitment route approved, in the vendor's currency. */
    approvedTotal: money('approved_total').notNull(),
    /** NPR per unit (1 for NPR), with its source and date for a foreign currency. */
    fxRate: fxRate('fx_rate').notNull(),
    fxSource: text('fx_source'),
    fxDate: date('fx_date', { mode: 'string' }),
    approvedTotalNpr: money('approved_total_npr').notNull(),
    approvedBand: text('approved_band', { enum: PO_APPROVED_BANDS }).notNull(),
    currentVersion: integer('current_version').notNull().default(0),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    issuedBy: uuid('issued_by'),
    closedReason: text('closed_reason'),
    createdBy: uuid('created_by').notNull(),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('purchase_orders_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent key of purchase_order_lines: a line prices a line of the PO's own request.
    unique('purchase_orders_tenant_org_pr_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseRequestId,
      t.id,
    ),
    unique('purchase_orders_tenant_org_vendor_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.vendorId,
      t.id,
    ),
    unique('purchase_orders_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    unique('purchase_orders_tenant_org_fy_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.fiscalYear,
      t.numberSeq,
    ),
    foreignKey({
      name: 'purchase_orders_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'purchase_orders_purchase_request_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId],
      foreignColumns: [
        purchaseRequests.tenantId,
        purchaseRequests.organizationId,
        purchaseRequests.id,
      ],
    }),
    foreignKey({
      name: 'purchase_orders_rfq_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId, t.rfqId],
      foreignColumns: [rfqs.tenantId, rfqs.organizationId, rfqs.purchaseRequestId, rfqs.id],
    }),
    foreignKey({
      name: 'purchase_orders_quotation_fk',
      columns: [t.tenantId, t.organizationId, t.rfqId, t.vendorQuotationId],
      foreignColumns: [
        vendorQuotations.tenantId,
        vendorQuotations.organizationId,
        vendorQuotations.rfqId,
        vendorQuotations.id,
      ],
    }),
    foreignKey({
      name: 'purchase_orders_quotation_vendor_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId, t.vendorQuotationId],
      foreignColumns: [
        vendorQuotations.tenantId,
        vendorQuotations.organizationId,
        vendorQuotations.vendorId,
        vendorQuotations.id,
      ],
    }),
    // The vendor must have an account in this entity (a vendor of another entity only is a 23503).
    foreignKey({
      name: 'purchase_orders_vendor_account_fk',
      columns: [t.tenantId, t.organizationId, t.vendorId],
      foreignColumns: [
        vendorAccounts.tenantId,
        vendorAccounts.organizationId,
        vendorAccounts.vendorId,
      ],
    }),
    foreignKey({
      name: 'purchase_orders_issued_by_fk',
      columns: [t.tenantId, t.issuedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'purchase_orders_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    // PostgreSQL has no partial unique constraint, so this is a unique index.
    uniqueIndex('purchase_orders_tenant_quotation_live_unique')
      .on(t.tenantId, t.vendorQuotationId)
      .where(sql`${t.status} <> 'cancelled' AND ${t.vendorQuotationId} IS NOT NULL`),
    index('purchase_orders_tenant_org_status_idx').on(t.tenantId, t.organizationId, t.status),
    index('purchase_orders_tenant_org_vendor_idx').on(t.tenantId, t.organizationId, t.vendorId),
    check(
      'purchase_orders_status_check',
      sql`${t.status} in ('draft', 'issued', 'partially_received', 'fully_received', 'amendment_pending', 'closed', 'short_closed', 'cancelled')`,
    ),
    check(
      'purchase_orders_approved_band_check',
      sql`${t.approvedBand} in ('base', 'management', 'founder')`,
    ),
    check('purchase_orders_currency_check', sql`${t.currency} in ('NPR', 'INR', 'USD')`),
    check(
      'purchase_orders_source_check',
      sql`(${t.rfqId} IS NULL) = (${t.vendorQuotationId} IS NULL)`,
    ),
    check('purchase_orders_number_seq_check', sql`${t.numberSeq} >= 1`),
    check('purchase_orders_payment_terms_days_check', sql`${t.paymentTermsDays} >= 0`),
    check('purchase_orders_advance_percent_check', sql`${t.advancePercent} BETWEEN 0 AND 100`),
    check(
      'purchase_orders_approved_total_check',
      sql`${t.approvedTotal} >= 0 AND ${t.approvedTotalNpr} >= 0`,
    ),
    check('purchase_orders_fx_rate_check', sql`${t.fxRate} > 0`),
    check(
      'purchase_orders_npr_snapshot_check',
      sql`${t.currency} <> 'NPR' OR (${t.fxRate} = 1 AND ${t.approvedTotalNpr} = ${t.approvedTotal})`,
    ),
    check(
      'purchase_orders_fx_source_check',
      sql`${t.currency} = 'NPR' OR (${t.fxSource} IS NOT NULL AND ${t.fxDate} IS NOT NULL)`,
    ),
    check('purchase_orders_current_version_check', sql`${t.currentVersion} >= 0`),
    check(
      'purchase_orders_issued_check',
      sql`${t.status} = 'draft' OR (${t.issuedAt} IS NOT NULL AND ${t.issuedBy} IS NOT NULL AND ${t.currentVersion} >= 1)`,
    ),
    check(
      'purchase_orders_closed_reason_check',
      sql`${t.status} NOT IN ('short_closed', 'cancelled') OR (${t.closedReason} IS NOT NULL AND btrim(${t.closedReason}) <> '')`,
    ),
    check('purchase_orders_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * One issued version of a PO (AD7): totals, band, full snapshot and, from version 2 on, the reason. Immutable:
 * purchase_order_versions_immutable refuses UPDATE and DELETE, and bos_app holds neither privilege.
 */
export const purchaseOrderVersions = appSchema.table(
  'purchase_order_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    version: integer('version').notNull(),
    reason: text('reason'),
    total: money('total').notNull(),
    totalNpr: money('total_npr').notNull(),
    band: text('band', { enum: PO_APPROVED_BANDS }).notNull(),
    snapshot: jsonb('snapshot').notNull(),
    approvalRequestId: uuid('approval_request_id'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('purchase_order_versions_tenant_org_po_version_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseOrderId,
      t.version,
    ),
    foreignKey({
      name: 'purchase_order_versions_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'purchase_order_versions_purchase_order_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.organizationId, purchaseOrders.id],
    }),
    foreignKey({
      name: 'purchase_order_versions_approval_request_fk',
      columns: [t.tenantId, t.organizationId, t.approvalRequestId],
      foreignColumns: [
        approvalRequests.tenantId,
        approvalRequests.organizationId,
        approvalRequests.id,
      ],
    }),
    foreignKey({
      name: 'purchase_order_versions_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('purchase_order_versions_version_check', sql`${t.version} >= 1`),
    check(
      'purchase_order_versions_reason_check',
      sql`${t.version} = 1 OR (${t.reason} IS NOT NULL AND btrim(${t.reason}) <> '')`,
    ),
    check('purchase_order_versions_total_check', sql`${t.total} >= 0 AND ${t.totalNpr} >= 0`),
    check(
      'purchase_order_versions_band_check',
      sql`${t.band} in ('base', 'management', 'founder')`,
    ),
  ],
);

/**
 * One line of a PO; its id is stable across versions. `purchaseRequestId` is the PO's own, so `prLineId` can only
 * be a line of that request. gross = round(orderedQuantity * unitPrice, 2); lineTotal = gross + taxAmount.
 */
export const purchaseOrderLines = appSchema.table(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    purchaseRequestId: uuid('purchase_request_id').notNull(),
    lineNo: integer('line_no').notNull(),
    prLineId: uuid('pr_line_id'),
    kind: text('kind', { enum: PO_LINE_KINDS }).notNull(),
    description: text('description').notNull(),
    uom: text('uom').notNull(),
    orderedQuantity: quantity('ordered_quantity').notNull(),
    /** Short-close or cancel; ordered - cancelled is what may still be received. */
    cancelledQuantity: quantity('cancelled_quantity').notNull().default('0'),
    unitPrice: money('unit_price').notNull(),
    taxCodeId: uuid('tax_code_id').notNull(),
    gross: money('gross').notNull(),
    taxAmount: money('tax_amount').notNull(),
    lineTotal: money('line_total').notNull(),
    requiresSerials: boolean('requires_serials').notNull().default(false),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('purchase_order_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent key of receipt_lines: a receipt line receives against a line of its own PO.
    unique('purchase_order_lines_tenant_org_po_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseOrderId,
      t.id,
    ),
    unique('purchase_order_lines_tenant_po_line_no_unique').on(
      t.tenantId,
      t.purchaseOrderId,
      t.lineNo,
    ),
    foreignKey({
      name: 'purchase_order_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'purchase_order_lines_purchase_order_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId, t.purchaseOrderId],
      foreignColumns: [
        purchaseOrders.tenantId,
        purchaseOrders.organizationId,
        purchaseOrders.purchaseRequestId,
        purchaseOrders.id,
      ],
    }),
    foreignKey({
      name: 'purchase_order_lines_pr_line_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseRequestId, t.prLineId],
      foreignColumns: [
        purchaseRequestLines.tenantId,
        purchaseRequestLines.organizationId,
        purchaseRequestLines.purchaseRequestId,
        purchaseRequestLines.id,
      ],
    }),
    foreignKey({
      name: 'purchase_order_lines_tax_code_fk',
      columns: [t.tenantId, t.taxCodeId],
      foreignColumns: [taxCodes.tenantId, taxCodes.id],
    }),
    index('purchase_order_lines_tenant_tax_code_idx').on(t.tenantId, t.taxCodeId),
    check('purchase_order_lines_kind_check', sql`${t.kind} in ('goods', 'service')`),
    check('purchase_order_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('purchase_order_lines_ordered_quantity_check', sql`${t.orderedQuantity} > 0`),
    check(
      'purchase_order_lines_cancelled_check',
      sql`${t.cancelledQuantity} >= 0 AND ${t.cancelledQuantity} <= ${t.orderedQuantity}`,
    ),
    check('purchase_order_lines_unit_price_check', sql`${t.unitPrice} >= 0`),
    check(
      'purchase_order_lines_gross_check',
      sql`${t.gross} = round(${t.orderedQuantity} * ${t.unitPrice}, 2)`,
    ),
    check('purchase_order_lines_tax_amount_check', sql`${t.taxAmount} >= 0`),
    check(
      'purchase_order_lines_line_total_check',
      sql`${t.lineTotal} = ${t.gross} + ${t.taxAmount}`,
    ),
    check(
      'purchase_order_lines_serials_check',
      sql`${t.requiresSerials} = false OR ${t.kind} = 'goods'`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------------------------------------------

/**
 * A goods receipt or service confirmation of one PO, with its GRN number. A receipt that reverses another
 * (`reversesReceiptId`, of the same PO) names the reason; each receipt is reversed at most once.
 */
export const receipts = appSchema.table(
  'receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    /** The GRN number, from NumberingService, with its sequence and fiscal year. */
    number: text('number').notNull(),
    numberSeq: integer('number_seq').notNull(),
    fiscalYear: text('fiscal_year').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    kind: text('kind', { enum: RECEIPT_KINDS }).notNull(),
    receivedAt: date('received_at', { mode: 'string' }).notNull(),
    location: text('location'),
    status: text('status', { enum: RECEIPT_STATUSES }).notNull().default('draft'),
    createdBy: uuid('created_by').notNull(),
    confirmedBy: uuid('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    reversesReceiptId: uuid('reverses_receipt_id'),
    reversalReason: text('reversal_reason'),
    version: integer('version').notNull().default(1),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('receipts_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent key of receipt_lines and of reverses_fk: both stay on the receipt's own PO.
    unique('receipts_tenant_org_po_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.purchaseOrderId,
      t.id,
    ),
    unique('receipts_tenant_org_number_unique').on(t.tenantId, t.organizationId, t.number),
    unique('receipts_tenant_org_fy_seq_unique').on(
      t.tenantId,
      t.organizationId,
      t.fiscalYear,
      t.numberSeq,
    ),
    foreignKey({
      name: 'receipts_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'receipts_purchase_order_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.tenantId, purchaseOrders.organizationId, purchaseOrders.id],
    }),
    foreignKey({
      name: 'receipts_reverses_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseOrderId, t.reversesReceiptId],
      foreignColumns: [t.tenantId, t.organizationId, t.purchaseOrderId, t.id],
    }),
    foreignKey({
      name: 'receipts_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'receipts_confirmed_by_fk',
      columns: [t.tenantId, t.confirmedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    // Each receipt is reversed at most once.
    uniqueIndex('receipts_tenant_org_reverses_unique')
      .on(t.tenantId, t.organizationId, t.reversesReceiptId)
      .where(sql`${t.reversesReceiptId} IS NOT NULL`),
    index('receipts_tenant_org_po_idx').on(t.tenantId, t.organizationId, t.purchaseOrderId),
    check('receipts_kind_check', sql`${t.kind} in ('goods', 'service')`),
    check(
      'receipts_status_check',
      sql`${t.status} in ('draft', 'confirmed', 'reversed', 'discarded')`,
    ),
    check('receipts_number_seq_check', sql`${t.numberSeq} >= 1`),
    check(
      'receipts_confirmed_check',
      sql`${t.status} in ('draft', 'discarded') OR (${t.confirmedBy} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL)`,
    ),
    check(
      'receipts_reversal_check',
      sql`${t.reversesReceiptId} IS NULL OR (${t.reversesReceiptId} <> ${t.id} AND ${t.reversalReason} IS NOT NULL AND btrim(${t.reversalReason}) <> '')`,
    ),
    check('receipts_version_check', sql`${t.version} >= 1`),
  ],
);

/**
 * One line of a receipt: `quantity` of one PO line. Positive, except on a reversal line, which is negative and
 * names the line it reverses (`reversesReceiptLineId`, same PO line). receipt_lines_guard holds the over-receipt
 * and full-reversal rules; `overReceiptExceptionId` lets a line pass the over-receipt guard.
 */
export const receiptLines = appSchema.table(
  'receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    receiptId: uuid('receipt_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id').notNull(),
    poLineId: uuid('po_line_id').notNull(),
    lineNo: integer('line_no').notNull(),
    /** Negative only on a reversal line (reversal_check). */
    quantity: quantity('quantity').notNull(),
    reversesReceiptLineId: uuid('reverses_receipt_line_id'),
    inspection: text('inspection'),
    discrepancyNote: text('discrepancy_note'),
    /** No FK: there is no exceptions table yet; the service validates the id. */
    overReceiptExceptionId: uuid('over_receipt_exception_id'),
    ...timestamps,
  },
  (t): PgTableExtraConfigValue[] => [
    unique('receipt_lines_tenant_org_id_unique').on(t.tenantId, t.organizationId, t.id),
    // Parent key of reverses_fk: a reversal line reverses a line of the same PO line.
    unique('receipt_lines_tenant_org_po_line_id_unique').on(
      t.tenantId,
      t.organizationId,
      t.poLineId,
      t.id,
    ),
    unique('receipt_lines_tenant_receipt_line_no_unique').on(t.tenantId, t.receiptId, t.lineNo),
    unique('receipt_lines_tenant_receipt_po_line_unique').on(t.tenantId, t.receiptId, t.poLineId),
    foreignKey({
      name: 'receipt_lines_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'receipt_lines_receipt_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseOrderId, t.receiptId],
      foreignColumns: [
        receipts.tenantId,
        receipts.organizationId,
        receipts.purchaseOrderId,
        receipts.id,
      ],
    }),
    foreignKey({
      name: 'receipt_lines_po_line_fk',
      columns: [t.tenantId, t.organizationId, t.purchaseOrderId, t.poLineId],
      foreignColumns: [
        purchaseOrderLines.tenantId,
        purchaseOrderLines.organizationId,
        purchaseOrderLines.purchaseOrderId,
        purchaseOrderLines.id,
      ],
    }),
    foreignKey({
      name: 'receipt_lines_reverses_fk',
      columns: [t.tenantId, t.organizationId, t.poLineId, t.reversesReceiptLineId],
      foreignColumns: [t.tenantId, t.organizationId, t.poLineId, t.id],
    }),
    // Each line is reversed at most once.
    uniqueIndex('receipt_lines_tenant_org_reverses_unique')
      .on(t.tenantId, t.organizationId, t.reversesReceiptLineId)
      .where(sql`${t.reversesReceiptLineId} IS NOT NULL`),
    index('receipt_lines_tenant_org_po_line_idx').on(t.tenantId, t.organizationId, t.poLineId),
    check('receipt_lines_line_no_check', sql`${t.lineNo} >= 1`),
    check('receipt_lines_quantity_check', sql`${t.quantity} <> 0`),
    check(
      'receipt_lines_reversal_check',
      sql`(${t.reversesReceiptLineId} IS NULL) = (${t.quantity} > 0)`,
    ),
    check(
      'receipt_lines_reverses_self_check',
      sql`${t.reversesReceiptLineId} IS NULL OR ${t.reversesReceiptLineId} <> ${t.id}`,
    ),
  ],
);

/** A serial number a goods line took in; unique per receipt line. */
export const receiptSerials = appSchema.table(
  'receipt_serials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantColumn(),
    organizationId: uuid('organization_id').notNull(),
    receiptLineId: uuid('receipt_line_id').notNull(),
    serialNo: text('serial_no').notNull(),
    batchNo: text('batch_no'),
    warrantyUntil: date('warranty_until', { mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('receipt_serials_tenant_line_serial_unique').on(t.tenantId, t.receiptLineId, t.serialNo),
    foreignKey({
      name: 'receipt_serials_tenant_org_fk',
      columns: [t.tenantId, t.organizationId],
      foreignColumns: [organizations.tenantId, organizations.id],
    }),
    foreignKey({
      name: 'receipt_serials_receipt_line_fk',
      columns: [t.tenantId, t.organizationId, t.receiptLineId],
      foreignColumns: [receiptLines.tenantId, receiptLines.organizationId, receiptLines.id],
    }),
    check('receipt_serials_serial_no_check', sql`btrim(${t.serialNo}) <> ''`),
  ],
);
